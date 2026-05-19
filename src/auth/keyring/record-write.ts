import type { AuthAccount, TokenBundle } from '../types.js'
import { trySetSecret } from './internal.js'
import { type SecureStore, SecureStoreUnavailableError } from './secure-store.js'
import type { UserRecord, UserRecordStore } from './types.js'

type WriteRecordOptions<TAccount extends AuthAccount> = {
    /** Per-account keyring slot for the access token. */
    secureStore: SecureStore
    /**
     * Per-account keyring slot for the refresh token (separate slot under
     * `${account}/refresh`). When the bundle has no refresh token, any
     * previous secret in this slot is cleaned up **after** the record
     * write commits — see `purgeRefreshSlot` below for the opt-out and
     * the safety rationale.
     */
    refreshSecureStore: SecureStore
    userRecords: UserRecordStore<TAccount>
    account: TAccount
    bundle: TokenBundle
    /**
     * When `false`, skip the post-upsert defensive delete of the refresh
     * slot for bundles without a refresh token, and persist
     * `hasRefreshToken: undefined` instead of `false`. Used by
     * `migrateLegacyAuth`: the legacy bundle has no authority over
     * refresh state, so a stale slot must remain visible until a real v2
     * login decides what's there. Defaults to `true` (the safe default
     * for fresh logins).
     */
    purgeRefreshSlot?: boolean
}

type WriteRecordResult = {
    /** `true` when both access and refresh secrets landed in the OS keyring; `false` when the keyring was unavailable and the bundle was parked on the user record's `fallbackToken` / `fallbackRefreshToken`. */
    storedSecurely: boolean
}

/**
 * Shared keyring-then-record write used by `createKeyringTokenStore.set` /
 * `setBundle`. Encapsulates the order-of-operations contract that matters
 * for credential safety:
 *
 *   1. Keyring `setSecret` for the access token first. On
 *      `SecureStoreUnavailableError`, swallow and route both tokens to
 *      the record's fallback slots. Any other error rethrows.
 *   2. When the keyring is online and the bundle has a refresh token,
 *      write it to the sibling refresh slot. On
 *      `SecureStoreUnavailableError`, roll back the access-slot write
 *      and fall through to the fallback record (so both tokens travel
 *      together — never split state across keyring and record). On any
 *      other error, also roll back the access slot (best-effort) before
 *      rethrowing — leaving an orphan access credential with no matching
 *      user record breaks `active()` later.
 *   3. `userRecords.upsert(record)`. On failure, best-effort rollback
 *      both keyring writes so we don't leave orphan credentials for an
 *      account cli-core never managed to register. Original error
 *      rethrows.
 *   4. Post-upsert (success only): when the bundle had no refresh token
 *      and `purgeRefreshSlot` is `true`, best-effort delete any
 *      previous secret in the refresh slot. Done AFTER the record
 *      commits so a failed upsert can't destroy a previous refresh
 *      secret the caller may want to recover with. Made best-effort
 *      because the record's `hasRefreshToken: false` already prevents
 *      `active()` from reading the slot — a stale secret can't shadow
 *      anything; it's just dead bytes until the next write.
 */
export async function writeRecordWithKeyringFallback<TAccount extends AuthAccount>(
    options: WriteRecordOptions<TAccount>,
): Promise<WriteRecordResult> {
    const { secureStore, refreshSecureStore, userRecords, account, bundle } = options
    const purgeRefreshSlot = options.purgeRefreshSlot ?? true
    const trimmedAccess = bundle.accessToken.trim()
    const trimmedRefresh = bundle.refreshToken?.trim() || undefined

    async function rollbackAccess(error: unknown): Promise<void> {
        try {
            await secureStore.deleteSecret()
        } catch {
            // best-effort rollback
        }
        if (!(error instanceof SecureStoreUnavailableError)) throw error
    }

    let storedSecurely = await trySetSecret(secureStore, trimmedAccess)

    let wroteRefreshSecurely = false
    if (storedSecurely && trimmedRefresh) {
        try {
            await refreshSecureStore.setSecret(trimmedRefresh)
            wroteRefreshSecurely = true
        } catch (error) {
            storedSecurely = false
            await rollbackAccess(error)
        }
    }

    // `hasRefreshToken` advertises the truth about the slot to readers.
    // With a refresh in the bundle: `true`. Without, but with the
    // caller's authority to manage the slot (`purgeRefreshSlot: true`):
    // `false` (the post-upsert cleanup makes it true). Without that
    // authority (`purgeRefreshSlot: false`, used by `migrateLegacyAuth`):
    // `undefined` (readers probe the slot — a v2-written refresh secret
    // stays visible across a migration write that has no authority over
    // it).
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
            // Roll back both keyring writes concurrently. The refresh
            // slot is included only when we WROTE to it — never when
            // we'd be about to delete it (we haven't yet), because
            // deleting a slot the caller had pre-existing data in would
            // be the very bug this deferral was meant to prevent.
            await Promise.allSettled([
                secureStore.deleteSecret(),
                wroteRefreshSecurely ? refreshSecureStore.deleteSecret() : Promise.resolve(false),
            ])
        }
        throw error
    }

    // Post-upsert cleanup of the refresh slot when the bundle had no
    // refresh token. Best-effort: a failed delete leaves a stale secret
    // in the slot, but the record we just upserted has
    // `hasRefreshToken: false`, so `active()` will skip the slot read.
    // The stale bytes can't influence behaviour until the next write.
    // Crucially, deferring this until after the upsert commits means a
    // failed upsert can't destroy a refresh secret the caller may want
    // to recover with on retry.
    if (storedSecurely && !trimmedRefresh && purgeRefreshSlot) {
        await refreshSecureStore.deleteSecret().catch(() => undefined)
    }

    return { storedSecurely }
}
