import { CliError } from '../../errors.js'
import type { AccountRef, AuthAccount, TokenBundle, TokenStore } from '../types.js'
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
     * Human-readable location of the record store, used in the fallback-warning
     * text (e.g. `~/.config/todoist-cli/config.json`). Plain string; cli-core
     * does not interpret it.
     */
    recordsLocation: string
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
    /** Storage result from the most recent `set()` / `setBundle()` call, or `undefined` before any (and reset to `undefined` when the most recent call threw). */
    getLastStorageResult(): TokenStorageResult | undefined
    /** Storage result from the most recent `clear()` call, or `undefined` before any (and reset to `undefined` when the most recent `clear()` threw or was a no-op). */
    getLastClearResult(): TokenStorageResult | undefined
}

const DEFAULT_MATCH_ACCOUNT = <TAccount extends AuthAccount>(
    account: TAccount,
    ref: AccountRef,
): boolean => account.id === ref || account.label === ref

/** Sibling keyring slot for the refresh token. Single source of truth for the wire format. */
export function refreshAccountSlot(accessSlot: string): string {
    return `${accessSlot}/refresh`
}

/**
 * Multi-account `TokenStore` that keeps secrets in the OS credential manager
 * and per-user metadata in the consumer's `UserRecordStore`. Falls back to
 * plaintext tokens on the user record when the keyring is unreachable.
 *
 * Refresh tokens live in a sibling keyring slot (`${account}/refresh`) so
 * `clear()` can drop them without parsing the access slot's contents. Reads
 * are gated on `UserRecord.hasRefreshToken` so accounts without refresh
 * tokens don't pay a second keyring round-trip per `active()` call.
 */
export function createKeyringTokenStore<TAccount extends AuthAccount>(
    options: CreateKeyringTokenStoreOptions<TAccount>,
): KeyringTokenStore<TAccount> {
    const { serviceName, userRecords, recordsLocation } = options
    const accountForUser = options.accountForUser ?? DEFAULT_ACCOUNT_FOR_USER
    const matchAccount = options.matchAccount ?? DEFAULT_MATCH_ACCOUNT

    let lastStorageResult: TokenStorageResult | undefined
    let lastClearResult: TokenStorageResult | undefined

    function accessStoreFor(account: TAccount): SecureStore {
        return createSecureStore({ serviceName, account: accountForUser(account.id) })
    }

    function refreshStoreFor(account: TAccount): SecureStore {
        return createSecureStore({
            serviceName,
            account: refreshAccountSlot(accountForUser(account.id)),
        })
    }

    type Snapshot = { records: UserRecord<TAccount>[]; defaultId: string | null }

    async function readFullSnapshot(): Promise<Snapshot> {
        const [records, defaultId] = await Promise.all([
            userRecords.list(),
            userRecords.getDefaultId(),
        ])
        return { records, defaultId }
    }

    function resolveTarget(
        snapshot: Snapshot,
        ref: AccountRef | undefined,
    ): UserRecord<TAccount> | null {
        if (ref !== undefined) {
            const matches = snapshot.records.filter((record) => matchAccount(record.account, ref))
            if (matches.length > 1) {
                throw new CliError(
                    'NO_ACCOUNT_SELECTED',
                    `Multiple stored accounts match "${ref}". Pass a more specific --user <ref> (e.g. a unique account id).`,
                )
            }
            return matches[0] ?? null
        }
        if (snapshot.defaultId) {
            const pinned = snapshot.records.find((r) => r.account.id === snapshot.defaultId)
            if (pinned) return pinned
        }
        if (snapshot.records.length === 1) return snapshot.records[0]
        if (snapshot.records.length === 0) return null
        throw new CliError(
            'NO_ACCOUNT_SELECTED',
            'Multiple accounts are stored but none is set as the default. Pass --user <ref>, or set a default in your CLI.',
        )
    }

    function fallbackResult(action: string): TokenStorageResult {
        return {
            storage: 'config-file',
            warning: `${SECURE_STORE_DESCRIPTION} unavailable; ${action} ${recordsLocation}`,
        }
    }

    /**
     * Read the access + refresh secrets for a record, preferring the
     * plaintext fallbacks when present. Returns `null` when the access slot
     * is empty (corrupted state, surfaced to the caller as
     * `AUTH_STORE_READ_FAILED`).
     */
    async function readBundleForRecord(record: UserRecord<TAccount>): Promise<TokenBundle | null> {
        const fallbackAccess = record.fallbackToken?.trim()
        if (fallbackAccess) {
            return {
                accessToken: fallbackAccess,
                refreshToken: record.fallbackRefreshToken?.trim() || undefined,
                accessTokenExpiresAt: record.accessTokenExpiresAt,
                refreshTokenExpiresAt: record.refreshTokenExpiresAt,
            }
        }

        // Parallel reads: access slot always needed; refresh slot only when
        // the record says it exists. Sequential reads here would double the
        // IPC latency on every authenticated command. The refresh read is
        // wrapped in `.catch(() => null)` so a transient keyring hiccup on
        // the (non-essential) refresh slot doesn't fail an otherwise-valid
        // access-token lookup.
        const accessPromise = accessStoreFor(record.account)
            .getSecret()
            .catch((error: unknown) => {
                if (error instanceof SecureStoreUnavailableError) {
                    throw new CliError(
                        'AUTH_STORE_READ_FAILED',
                        `${SECURE_STORE_DESCRIPTION} unavailable; could not read stored token (${error.message})`,
                    )
                }
                throw error
            })
        const refreshPromise = record.hasRefreshToken
            ? refreshStoreFor(record.account)
                  .getSecret()
                  .catch(() => null)
            : Promise.resolve(null)

        const [rawAccess, rawRefresh] = await Promise.all([accessPromise, refreshPromise])

        const accessToken = rawAccess?.trim()
        if (!accessToken) return null

        return {
            accessToken,
            refreshToken: rawRefresh?.trim() || undefined,
            accessTokenExpiresAt: record.accessTokenExpiresAt,
            refreshTokenExpiresAt: record.refreshTokenExpiresAt,
        }
    }

    async function persistBundle(account: TAccount, bundle: TokenBundle): Promise<void> {
        lastStorageResult = undefined

        const { storedSecurely } = await writeRecordWithKeyringFallback({
            secureStore: accessStoreFor(account),
            refreshSecureStore: refreshStoreFor(account),
            userRecords,
            account,
            bundle,
        })

        // Best-effort default promotion: a failure here must not turn into
        // `AUTH_STORE_WRITE_FAILED` (the user can recover by setting a
        // default later).
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
    }

    return {
        async active(ref) {
            const snapshot: Snapshot =
                ref === undefined
                    ? await readFullSnapshot()
                    : { records: await userRecords.list(), defaultId: null }
            const record = resolveTarget(snapshot, ref)
            if (!record) return null

            const bundle = await readBundleForRecord(record)
            if (!bundle) {
                throw new CliError(
                    'AUTH_STORE_READ_FAILED',
                    `${SECURE_STORE_DESCRIPTION} returned no credential for the stored account; the keyring entry may have been removed externally.`,
                )
            }

            return { token: bundle.accessToken, bundle, account: record.account }
        },

        async set(account, token) {
            await persistBundle(account, { accessToken: token })
        },

        async setBundle(account, bundle) {
            await persistBundle(account, bundle)
        },

        async clear(ref) {
            lastClearResult = undefined

            const snapshot = await readFullSnapshot()
            const record = resolveTarget(snapshot, ref)
            if (!record) return

            await userRecords.remove(record.account.id)

            if (snapshot.defaultId === record.account.id) {
                try {
                    await userRecords.setDefaultId(null)
                } catch {
                    // best-effort
                }
            }

            const fallbackClear = fallbackResult('local auth state cleared in')

            // Always attempt to delete both keyring slots. Either may have
            // an orphan entry from a prior keyring-online write that was
            // later replaced by an offline-fallback write.
            let keyringClean = true
            try {
                await accessStoreFor(record.account).deleteSecret()
            } catch {
                keyringClean = false
            }
            try {
                await refreshStoreFor(record.account).deleteSecret()
            } catch {
                keyringClean = false
            }

            if (!keyringClean) {
                lastClearResult = fallbackClear
            } else {
                lastClearResult =
                    record.fallbackToken !== undefined ? fallbackClear : { storage: 'secure-store' }
            }
        },

        async list() {
            const snapshot = await readFullSnapshot()
            let implicitDefault: UserRecord<TAccount> | null = null
            try {
                implicitDefault = resolveTarget(snapshot, undefined)
            } catch {
                // multiple records, no default → `isDefault: false` for all
            }
            return snapshot.records.map((record) => ({
                account: record.account,
                isDefault: record.account.id === implicitDefault?.account.id,
            }))
        },

        async setDefault(ref) {
            const snapshot: Snapshot = { records: await userRecords.list(), defaultId: null }
            const record = resolveTarget(snapshot, ref)
            if (!record) {
                throw accountNotFoundError(ref)
            }
            await userRecords.setDefaultId(record.account.id)
        },

        getLastStorageResult() {
            return lastStorageResult
        },

        getLastClearResult() {
            return lastClearResult
        },
    }
}
