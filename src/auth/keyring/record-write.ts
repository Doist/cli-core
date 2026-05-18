import type { AuthAccount, TokenBundle } from '../types.js'
import { type SecureStore, SecureStoreUnavailableError } from './secure-store.js'
import type { UserRecord, UserRecordStore } from './types.js'

type WriteRecordOptions<TAccount extends AuthAccount> = {
    /** Per-account keyring slot for the access token. */
    secureStore: SecureStore
    /**
     * Per-account keyring slot for the refresh token (separate slot under
     * `${account}/refresh`). When the bundle has no refresh token this slot
     * is still cleared on write so a previous refresh secret doesn't outlive
     * a login that didn't return one — except when `purgeRefreshSlot: false`,
     * see below.
     */
    refreshSecureStore: SecureStore
    userRecords: UserRecordStore<TAccount>
    account: TAccount
    bundle: TokenBundle
    /**
     * When `false`, skip the defensive delete of the refresh slot for
     * bundles without a refresh token, and don't reset `hasRefreshToken`
     * on the persisted record. Used by `migrateLegacyAuth`: a retry after a
     * `marker-write-failed` may land on an account that has since logged in
     * via the v2 flow and now has a valid refresh secret — the legacy token
     * has no authority over refresh state and must not erase it. Defaults
     * to `true` (the safe default for fresh logins).
     */
    purgeRefreshSlot?: boolean
}

type WriteRecordResult = {
    /** `true` when both access and refresh secrets landed in the OS keyring; `false` when the keyring was unavailable and the bundle was parked on the user record's `fallbackToken` / `fallbackRefreshToken`. */
    storedSecurely: boolean
}

/**
 * Shared keyring-then-record write used by `createKeyringTokenStore.set` /
 * `setBundle` and `migrateLegacyAuth`. Encapsulates the order-of-operations
 * contract that matters for credential safety:
 *
 *   1. Keyring `setSecret` for the access token first. On
 *      `SecureStoreUnavailableError`, swallow and route both tokens to the
 *      record's fallback slots. Any other error rethrows.
 *   2. When the keyring is online and the bundle has a refresh token, write
 *      it to the sibling refresh slot. On `SecureStoreUnavailableError`,
 *      roll back the access-slot write and fall through to the fallback
 *      record (so both tokens travel together — never split state across
 *      keyring and record). On any other error, also roll back the access
 *      slot (best-effort) before rethrowing — leaving an orphan access
 *      credential with no matching user record breaks `active()` later.
 *   3. When the keyring is online and the bundle has no refresh token,
 *      delete any pre-existing refresh secret. A delete failure here is
 *      surfaced as a write failure (raised as `SecureStoreUnavailableError`'s
 *      semantic equivalent: fall through to the fallback record) so a stale
 *      refresh secret can never outlive a login that didn't return one —
 *      otherwise `active()` would later read and use it.
 *   4. `userRecords.upsert(record)`. On failure, best-effort rollback both
 *      keyring writes so we don't leave orphan credentials for an account
 *      cli-core never managed to register. Original error rethrows.
 */
export async function writeRecordWithKeyringFallback<TAccount extends AuthAccount>(
    options: WriteRecordOptions<TAccount>,
): Promise<WriteRecordResult> {
    const { secureStore, refreshSecureStore, userRecords, account, bundle } = options
    const purgeRefreshSlot = options.purgeRefreshSlot ?? true
    const trimmedAccess = bundle.accessToken.trim()
    const trimmedRefresh = bundle.refreshToken?.trim() || undefined

    /**
     * Best-effort access-slot rollback shared by both refresh-slot failure
     * paths (write + delete). When the keyring is partially offline (or
     * misbehaves), we route both tokens to the fallback record so they
     * travel together — never leave an orphan access credential.
     */
    async function rollbackAccess(error: unknown): Promise<void> {
        try {
            await secureStore.deleteSecret()
        } catch {
            // best-effort rollback
        }
        if (!(error instanceof SecureStoreUnavailableError)) throw error
    }

    let storedSecurely = false
    try {
        await secureStore.setSecret(trimmedAccess)
        storedSecurely = true
    } catch (error) {
        if (!(error instanceof SecureStoreUnavailableError)) throw error
    }

    let wroteRefreshSecurely = false
    if (storedSecurely) {
        if (trimmedRefresh) {
            try {
                await refreshSecureStore.setSecret(trimmedRefresh)
                wroteRefreshSecurely = true
            } catch (error) {
                storedSecurely = false
                await rollbackAccess(error)
            }
        } else if (purgeRefreshSlot) {
            // No refresh token in this bundle — purge any previous secret so
            // it can't shadow the new state. A delete failure here would let
            // a stale refresh token resurface on the next `active()`; safer
            // to fall through to the offline-fallback path. Callers that
            // know they have no authority over refresh state (e.g.
            // `migrateLegacyAuth`) pass `purgeRefreshSlot: false` to opt out
            // of this purge entirely.
            try {
                await refreshSecureStore.deleteSecret()
            } catch (error) {
                storedSecurely = false
                await rollbackAccess(error)
            }
        }
    }

    // Whether the record should advertise a refresh token: the bundle's
    // refresh wins; when the caller asked us not to touch the refresh slot
    // and the bundle has none, we have no authority to flip the bit so
    // leave the field unset. `undefined` is the contract's "I don't
    // know" — readers (`token-store.active()`) treat it as "try the slot
    // anyway", which lets a v2-written refresh secret remain visible
    // after a migration write that has no authority over it.
    const hasRefreshToken = Boolean(trimmedRefresh) || (!purgeRefreshSlot ? undefined : false)

    const baseRecord = {
        account,
        accessTokenExpiresAt: bundle.accessTokenExpiresAt,
        refreshTokenExpiresAt: bundle.refreshTokenExpiresAt,
        hasRefreshToken,
    }
    const record: UserRecord<TAccount> = storedSecurely
        ? baseRecord
        : {
              ...baseRecord,
              fallbackToken: trimmedAccess,
              fallbackRefreshToken: trimmedRefresh,
          }

    try {
        await userRecords.upsert(record)
    } catch (error) {
        if (storedSecurely) {
            // Roll back both keyring writes concurrently — independent calls
            // and the IPC round-trip is the latency-heavy part. `allSettled`
            // also keeps the user-record error (the real failure) from
            // being shadowed by a rollback throw.
            await Promise.allSettled([
                secureStore.deleteSecret(),
                wroteRefreshSecurely ? refreshSecureStore.deleteSecret() : Promise.resolve(false),
            ])
        }
        throw error
    }

    return { storedSecurely }
}
