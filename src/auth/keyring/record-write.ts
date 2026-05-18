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
 * Shared keyring-then-record write used by `createKeyringTokenStore.set` and
 * `migrateLegacyAuth`. Encapsulates the order-of-operations contract that
 * matters for credential safety:
 *
 *   1. Keyring `setSecret` for access token first. On
 *      `SecureStoreUnavailableError`, swallow and route both tokens to the
 *      record's fallback slots. Any other error rethrows.
 *   2. When the keyring is online and the bundle has a refresh token, write
 *      it to the sibling refresh slot. When the bundle has no refresh token,
 *      best-effort `deleteSecret()` on the refresh slot so a stale secret
 *      from a previous login doesn't shadow the new state.
 *   3. `userRecords.upsert(record)`. On failure, best-effort rollback both
 *      keyring writes so we don't leave orphan credentials for an account
 *      cli-core never managed to register. Original error rethrows.
 *
 * Default promotion (`setDefaultId`) is intentionally **not** in here — both
 * call sites do it best-effort outside the critical section because it is a
 * preference, not a correctness requirement, and an error there must not
 * dirty up a successful credential write.
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

    // Refresh slot mirrors the access slot's online/offline branch. When
    // online without a refresh token, clear the slot defensively — a
    // re-login that no longer returns refresh shouldn't leave a stale
    // refresh secret behind that `active()` would happily return.
    let wroteRefreshSecurely = false
    if (storedSecurely) {
        if (trimmedRefresh) {
            try {
                await refreshSecureStore.setSecret(trimmedRefresh)
                wroteRefreshSecurely = true
            } catch (error) {
                if (!(error instanceof SecureStoreUnavailableError)) throw error
                // Refresh slot offline but access slot was online — treat as
                // partial offline: park everything on the record fallback so
                // `active()` reads from a single consistent place.
                try {
                    await secureStore.deleteSecret()
                } catch {
                    // best-effort rollback
                }
                storedSecurely = false
            }
        } else {
            // No refresh token in this bundle — purge any previous secret.
            try {
                await refreshSecureStore.deleteSecret()
            } catch {
                // best-effort
            }
        }
    }

    const record: UserRecord<TAccount> = storedSecurely
        ? {
              account,
              accessTokenExpiresAt: bundle.accessTokenExpiresAt,
              refreshTokenExpiresAt: bundle.refreshTokenExpiresAt,
          }
        : {
              account,
              fallbackToken: trimmedAccess,
              fallbackRefreshToken: trimmedRefresh,
              accessTokenExpiresAt: bundle.accessTokenExpiresAt,
              refreshTokenExpiresAt: bundle.refreshTokenExpiresAt,
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
