import { CliError } from '../../errors.js'
import type { AccountRef, AuthAccount, TokenStore } from '../types.js'
import { accountNotFoundError } from '../user-flag.js'
import { writeRecordWithKeyringFallback } from './record-write.js'
import {
    createSecureStore,
    DEFAULT_ACCOUNT_FOR_USER,
    SECURE_STORE_DESCRIPTION,
    SecureStoreUnavailableError,
    type SecureStore,
} from './secure-store.js'
import type { TokenStorageResult, UserRecord, UserRecordStore } from './types.js'

export type CreateKeyringTokenStoreOptions<TAccount extends AuthAccount> = {
    /** Application identifier used for every keyring entry (e.g. `'todoist-cli'`). */
    serviceName: string
    /** Consumer-owned per-user record store (typically backed by their config file). */
    userRecords: UserRecordStore<TAccount>
    /**
     * Builds the keyring `account` slug for a user id. Defaults to
     * `user-${id}`. Override only when migrating from a legacy naming scheme.
     */
    accountForUser?: (id: string) => string
    /**
     * Decides whether an account matches an `AccountRef` supplied via
     * `--user <ref>`. Defaults to id-or-label equality. Override to broaden
     * (e.g. case-insensitive email, alias map).
     */
    matchAccount?: (account: TAccount, ref: AccountRef) => boolean
}

export type KeyringTokenStore<TAccount extends AuthAccount> = TokenStore<TAccount> & {
    /** Storage result from the most recent `set()` call, or `undefined` before any. */
    getLastStorageResult(): TokenStorageResult | undefined
    /** Storage result from the most recent `clear()` call, or `undefined` before any. */
    getLastClearResult(): TokenStorageResult | undefined
}

const DEFAULT_MATCH_ACCOUNT = <TAccount extends AuthAccount>(
    account: TAccount,
    ref: AccountRef,
): boolean => account.id === ref || account.label === ref

/**
 * Multi-account `TokenStore` that keeps secrets in the OS credential manager
 * and per-user metadata in the consumer's `UserRecordStore`. Falls back to a
 * plaintext token on the user record when the keyring is unreachable (WSL
 * without D-Bus, missing native binary, locked Keychain, …) so the CLI keeps
 * working at the cost of a visible warning.
 *
 * Read order in `active()` is `fallbackToken` first, then the keyring. That
 * matches the write semantics in `writeRecordWithKeyringFallback`: when the
 * keyring is online the record is written with no `fallbackToken`, so the
 * keyring read is the only path. When the keyring is offline the token is
 * parked on the record and must be reachable on every subsequent read.
 *
 * Write order is keyring first, then `userRecords.upsert`. If the upsert
 * fails after a successful keyring write, the keyring entry is rolled back
 * via `deleteSecret()` to avoid orphan credentials for a user that cli-core
 * never managed to record.
 *
 * Clear order is the inverse: record removal first (the source of truth that
 * the rest of the CLI reads), then keyring delete. A keyring delete failure
 * after a successful removal is downgraded to a warning — the orphan secret
 * is harmless because no record references it anymore.
 */
export function createKeyringTokenStore<TAccount extends AuthAccount>(
    options: CreateKeyringTokenStoreOptions<TAccount>,
): KeyringTokenStore<TAccount> {
    const { serviceName, userRecords } = options
    const accountForUser = options.accountForUser ?? DEFAULT_ACCOUNT_FOR_USER
    const matchAccount = options.matchAccount ?? DEFAULT_MATCH_ACCOUNT

    let lastStorageResult: TokenStorageResult | undefined
    let lastClearResult: TokenStorageResult | undefined

    function secureStoreFor(id: string): SecureStore {
        return createSecureStore({ serviceName, account: accountForUser(id) })
    }

    type Snapshot = { records: UserRecord<TAccount>[]; defaultId: string | null }

    // `getDefaultId` is only needed when no ref is supplied — every
    // authenticated command sits on `active()`, so skipping the extra config
    // read on the `--user <ref>` path matters for latency.
    async function readSnapshot(needsDefault: boolean): Promise<Snapshot> {
        if (needsDefault) {
            const [records, defaultId] = await Promise.all([
                userRecords.list(),
                userRecords.getDefaultId(),
            ])
            return { records, defaultId }
        }
        return { records: await userRecords.list(), defaultId: null }
    }

    function findByRef(snapshot: Snapshot, ref: AccountRef): UserRecord<TAccount> | null {
        return snapshot.records.find((record) => matchAccount(record.account, ref)) ?? null
    }

    function resolveDefault(snapshot: Snapshot): UserRecord<TAccount> | null {
        if (snapshot.defaultId) {
            const found = snapshot.records.find((r) => r.id === snapshot.defaultId)
            if (found) return found
        }
        return snapshot.records.length === 1 ? snapshot.records[0] : null
    }

    function fallbackResult(action: string): TokenStorageResult {
        return {
            storage: 'config-file',
            warning: buildFallbackWarning(action, userRecords.describeLocation()),
        }
    }

    return {
        async active(ref) {
            const snapshot = await readSnapshot(ref === undefined)
            const record = ref === undefined ? resolveDefault(snapshot) : findByRef(snapshot, ref)
            if (!record) return null

            if (record.fallbackToken?.trim()) {
                return { token: record.fallbackToken.trim(), account: record.account }
            }

            try {
                const token = await secureStoreFor(record.id).getSecret()
                if (token?.trim()) {
                    return { token: token.trim(), account: record.account }
                }
                return null
            } catch (error) {
                // A matching record exists but the keyring can't be read.
                // Surface a typed failure instead of returning `null`, which
                // would otherwise be indistinguishable from "no stored
                // account" and trigger `ACCOUNT_NOT_FOUND` on `--user <ref>`.
                // `attachLogoutCommand` catches this specific code so an
                // explicit `logout --user <ref>` can still clear the matching
                // record without needing the unreadable token.
                if (error instanceof SecureStoreUnavailableError) {
                    throw new CliError(
                        'AUTH_STORE_READ_FAILED',
                        `${SECURE_STORE_DESCRIPTION} unavailable; could not read stored token (${error.message})`,
                    )
                }
                throw error
            }
        },

        async set(account, token) {
            const { storedSecurely } = await writeRecordWithKeyringFallback({
                serviceName,
                accountForUser,
                userRecords,
                account,
                token,
            })

            // Best-effort default promotion: the record is already persisted,
            // so a failure here must not turn into `AUTH_STORE_WRITE_FAILED`
            // (the user can recover with `<cli> account use`).
            try {
                const existingDefault = await userRecords.getDefaultId()
                if (!existingDefault) {
                    await userRecords.setDefaultId(account.id)
                }
            } catch {
                // best-effort
            }

            lastStorageResult = storedSecurely
                ? { storage: 'secure-store' }
                : fallbackResult('token saved as plaintext in')
        },

        async clear(ref) {
            const snapshot = await readSnapshot(ref === undefined)
            const record = ref === undefined ? resolveDefault(snapshot) : findByRef(snapshot, ref)
            if (!record) {
                lastClearResult = undefined
                return
            }

            await userRecords.remove(record.id)

            // Default un-pinning is best-effort: a failure here must not
            // skip the keyring delete below, otherwise we leave an
            // unreachable orphan secret behind for the just-removed record.
            const wasDefault = await readWasDefault(userRecords, record.id, snapshot)
            if (wasDefault) {
                try {
                    await userRecords.setDefaultId(null)
                } catch {
                    // best-effort
                }
            }

            const fallbackClear = fallbackResult('local auth state cleared in')

            // Always attempt the keyring delete. Even when the record carried
            // a `fallbackToken`, an older keyring entry may still be parked
            // there from a prior keyring-online write that was later replaced
            // by an offline-fallback write — skipping the delete would leak
            // that orphan.
            try {
                await secureStoreFor(record.id).deleteSecret()
                lastClearResult =
                    record.fallbackToken !== undefined ? fallbackClear : { storage: 'secure-store' }
            } catch (error) {
                if (!(error instanceof SecureStoreUnavailableError)) throw error
                lastClearResult = fallbackClear
            }
        },

        async list() {
            const snapshot = await readSnapshot(true)
            const implicitDefault = resolveDefault(snapshot)
            return snapshot.records.map((record) => ({
                account: record.account,
                isDefault: record.id === implicitDefault?.id,
            }))
        },

        async setDefault(ref) {
            const all = await userRecords.list()
            const record = all.find((r) => matchAccount(r.account, ref))
            if (!record) {
                throw accountNotFoundError(ref)
            }
            await userRecords.setDefaultId(record.id)
        },

        getLastStorageResult() {
            return lastStorageResult
        },

        getLastClearResult() {
            return lastClearResult
        },
    }
}

async function readWasDefault<TAccount extends AuthAccount>(
    userRecords: UserRecordStore<TAccount>,
    id: string,
    snapshot: { defaultId: string | null },
): Promise<boolean> {
    // `clear(ref)` skipped the default read in `readSnapshot`, so check now.
    if (snapshot.defaultId !== null) return snapshot.defaultId === id
    const current = await userRecords.getDefaultId()
    return current === id
}

function buildFallbackWarning(action: string, location: string): string {
    return `${SECURE_STORE_DESCRIPTION} unavailable; ${action} ${location}`
}
