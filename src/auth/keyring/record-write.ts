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
     * a login that didn't return one.
     */
    refreshSecureStore: SecureStore
    userRecords: UserRecordStore<TAccount>
    account: TAccount
    bundle: TokenBundle
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
    const trimmedAccess = bundle.accessToken.trim()
    const trimmedRefresh = bundle.refreshToken?.trim() || undefined

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
                // Best-effort rollback of the access slot regardless of error
                // shape — otherwise we leave an orphan access credential for
                // an account cli-core hasn't recorded yet. After rollback
                // we fall through to either the offline-fallback record
                // (keyring) or rethrow (other).
                try {
                    await secureStore.deleteSecret()
                } catch {
                    // best-effort rollback
                }
                storedSecurely = false
                if (!(error instanceof SecureStoreUnavailableError)) throw error
            }
        } else {
            // No refresh token in this bundle — purge any previous secret so
            // it can't shadow the new state. A delete failure here would let
            // a stale refresh token resurface on the next `active()`; safer
            // to fall through to the offline-fallback path and roll back the
            // access slot, mirroring the keyring-unavailable branch above.
            try {
                await refreshSecureStore.deleteSecret()
            } catch (error) {
                try {
                    await secureStore.deleteSecret()
                } catch {
                    // best-effort
                }
                storedSecurely = false
                if (!(error instanceof SecureStoreUnavailableError)) throw error
            }
        }
    }

    const record: UserRecord<TAccount> = storedSecurely
        ? {
              account,
              accessTokenExpiresAt: bundle.accessTokenExpiresAt,
              refreshTokenExpiresAt: bundle.refreshTokenExpiresAt,
              hasRefreshToken: Boolean(trimmedRefresh),
          }
        : {
              account,
              fallbackToken: trimmedAccess,
              fallbackRefreshToken: trimmedRefresh,
              accessTokenExpiresAt: bundle.accessTokenExpiresAt,
              refreshTokenExpiresAt: bundle.refreshTokenExpiresAt,
              hasRefreshToken: Boolean(trimmedRefresh),
          }

    try {
        await userRecords.upsert(record)
    } catch (error) {
        if (storedSecurely) {
            try {
                await secureStore.deleteSecret()
            } catch {
                // best-effort — the user record failure is the real cause
            }
            if (wroteRefreshSecurely) {
                try {
                    await refreshSecureStore.deleteSecret()
                } catch {
                    // best-effort
                }
            }
        }
        throw error
    }

    return { storedSecurely }
}
