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
    /** Storage result from the most recent `set()` call, or `undefined` before any (and reset to `undefined` when the most recent `set()` threw). */
    getLastStorageResult(): TokenStorageResult | undefined
    /** Storage result from the most recent `clear()` call, or `undefined` before any (and reset to `undefined` when the most recent `clear()` threw or was a no-op). */
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
 * the rest of the CLI reads), then keyring delete. Any keyring delete
 * failure after a successful removal is downgraded to a warning — the orphan
 * secret is harmless because no record references it anymore, and surfacing
 * the error would corrupt local state (record gone, but caller sees a thrown
 * exception and assumes the clear failed).
 */
export function createKeyringTokenStore<TAccount extends AuthAccount>(
    options: CreateKeyringTokenStoreOptions<TAccount>,
): KeyringTokenStore<TAccount> {
    const { serviceName, userRecords, recordsLocation } = options
    const accountForUser = options.accountForUser ?? DEFAULT_ACCOUNT_FOR_USER
    const matchAccount = options.matchAccount ?? DEFAULT_MATCH_ACCOUNT

    let lastStorageResult: TokenStorageResult | undefined
    let lastClearResult: TokenStorageResult | undefined

    function secureStoreFor(account: TAccount): SecureStore {
        return createSecureStore({ serviceName, account: accountForUser(account.id) })
    }

    type Snapshot = { records: UserRecord<TAccount>[]; defaultId: string | null }

    /**
     * Read both `list()` and `getDefaultId()` concurrently. Used by paths
     * that need the pinned default (no-ref `active`/`clear`, `list`, and
     * `clear`'s default-unpin check).
     */
    async function readFullSnapshot(): Promise<Snapshot> {
        const [records, defaultId] = await Promise.all([
            userRecords.list(),
            userRecords.getDefaultId(),
        ])
        return { records, defaultId }
    }

    /**
     * Resolve the snapshot target for a given ref (or the implicit default
     * when `ref === undefined`). Two failure modes:
     *
     * - Multiple records match the `ref`: ambiguous (the default matcher
     *   includes `account.label`, and labels aren't guaranteed unique).
     *   Throws `NO_ACCOUNT_SELECTED` so the user picks a tighter ref instead
     *   of silently acting on whichever record `list()` returned first.
     * - `ref === undefined`, no `defaultId` pinned, and more than one record
     *   exists. Same code — `setDefaultId` is best-effort during `set()`,
     *   so a typed failure here is the only non-misleading signal for "you
     *   have multiple accounts; pick one".
     */
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

    return {
        async active(ref) {
            // Ref-only path skips `getDefaultId()` — `resolveTarget` never
            // touches it when `ref` is supplied, so the extra read would be
            // pure latency on every authenticated command.
            const snapshot: Snapshot =
                ref === undefined
                    ? await readFullSnapshot()
                    : { records: await userRecords.list(), defaultId: null }
            const record = resolveTarget(snapshot, ref)
            if (!record) return null

            const fallback = record.fallbackToken?.trim()
            if (fallback) {
                return { token: fallback, account: record.account }
            }

            let raw: string | null
            try {
                raw = await secureStoreFor(record.account).getSecret()
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

            const token = raw?.trim()
            if (token) {
                return { token, account: record.account }
            }

            // Record exists, no `fallbackToken`, and the keyring slot is
            // empty — the credential was deleted out-of-band (user ran
            // `security delete-generic-password`, `secret-tool clear`, …).
            // This is corrupted state, not a miss; collapsing it to `null`
            // would make `--user <ref>` surface as `ACCOUNT_NOT_FOUND` and
            // hide the real problem.
            throw new CliError(
                'AUTH_STORE_READ_FAILED',
                `${SECURE_STORE_DESCRIPTION} returned no credential for the stored account; the keyring entry may have been removed externally.`,
            )
        },

        async set(account, token) {
            // Reset the cached storage result up front so a caller that
            // catches a thrown `set()` doesn't observe the previous call's
            // warning leaking through `getLastStorageResult`.
            lastStorageResult = undefined

            const { storedSecurely } = await writeRecordWithKeyringFallback({
                secureStore: secureStoreFor(account),
                userRecords,
                account,
                token,
            })

            // Best-effort default promotion: the record is already persisted,
            // so a failure here must not turn into `AUTH_STORE_WRITE_FAILED`
            // (the user can recover by setting a default later).
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
            // Reset up front for the same reason as `set` — and so a no-op
            // (no matching record) clears any stale result from a previous
            // call.
            lastClearResult = undefined

            // `clear` always needs the pinned default to decide whether to
            // un-pin after the removal, so we can't skip `getDefaultId()`
            // even on the explicit-ref path.
            const snapshot = await readFullSnapshot()
            const record = resolveTarget(snapshot, ref)
            if (!record) return

            await userRecords.remove(record.account.id)

            // Default un-pinning is best-effort: a failure here must not
            // skip the keyring delete below, otherwise we leave an
            // unreachable orphan secret behind for the just-removed record.
            if (snapshot.defaultId === record.account.id) {
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
            // that orphan. Downgrade *any* failure to a warning: the record
            // is already gone, so re-throwing would corrupt local state
            // (caller sees an exception and assumes nothing was cleared,
            // even though the next `account list` will show the user gone).
            try {
                await secureStoreFor(record.account).deleteSecret()
                lastClearResult =
                    record.fallbackToken !== undefined ? fallbackClear : { storage: 'secure-store' }
            } catch {
                lastClearResult = fallbackClear
            }
        },

        async list() {
            const snapshot = await readFullSnapshot()
            // Use `resolveTarget` to compute the *effective* default so the
            // `isDefault` markers match what `active()` would resolve — that
            // includes the implicit single-record case. `resolveTarget` can
            // throw `NO_ACCOUNT_SELECTED`, which we want to swallow here
            // (listing accounts is a diagnostic operation that must work
            // even when no default is pinned).
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
            // Ref-only path — skip `getDefaultId()` like `active(ref)`.
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
