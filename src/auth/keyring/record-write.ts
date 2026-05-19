import type { AuthAccount, TokenBundle } from '../types.js'
import { type SecureStore, SecureStoreUnavailableError } from './secure-store.js'
import type { UserRecord, UserRecordStore } from './types.js'

type WriteRecordOptions<TAccount extends AuthAccount> = {
    /** Per-account keyring slot, already configured by the caller (e.g. via `createSecureStore`). */
    secureStore: SecureStore
    userRecords: UserRecordStore<TAccount>
    account: TAccount
    token: string
}

type WriteRecordResult = {
    /** `true` when the secret landed in the OS keyring; `false` when the keyring was unavailable and the token was written to `fallbackToken` on the user record. */
    storedSecurely: boolean
}

type WriteBundleOptions<TAccount extends AuthAccount> = {
    /** Per-account access-token keyring slot. */
    accessStore: SecureStore
    /** Per-account refresh-token keyring slot. */
    refreshStore: SecureStore
    userRecords: UserRecordStore<TAccount>
    account: TAccount
    bundle: TokenBundle
}

export type WriteBundleResult = {
    /** `true` when the access token landed in the OS keyring; `false` when it fell back to `fallbackToken`. */
    accessStoredSecurely: boolean
    /**
     * `true` when a refresh token landed in the OS keyring. `false` when it
     * fell back to `fallbackRefreshToken`. `undefined` when the bundle
     * carried no refresh token (nothing to store).
     */
    refreshStoredSecurely: boolean | undefined
}

/**
 * Shared keyring-then-record write used by `createKeyringTokenStore.set` and
 * `migrateLegacyAuth`. Encapsulates the order-of-operations contract that
 * matters for credential safety:
 *
 *   1. Keyring `setSecret` first. On `SecureStoreUnavailableError`, swallow
 *      the failure and record a `fallbackToken` on the user record instead.
 *      Any other error rethrows.
 *   2. `userRecords.upsert(record)`. On failure, best-effort rollback the
 *      keyring write so we don't leave an orphan credential for an account
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
    const { secureStore, userRecords, account, token } = options
    const trimmed = token.trim()

    let storedSecurely = false
    try {
        await secureStore.setSecret(trimmed)
        storedSecurely = true
    } catch (error) {
        if (!(error instanceof SecureStoreUnavailableError)) throw error
    }

    // Mark the record as definitively having no refresh token. `set()` is
    // the single-token path — no refresh state is ever associated with it,
    // so the runtime's `active()` can skip the refresh-slot IPC instead of
    // probing-then-backfilling on every legacy record's first read.
    const record: UserRecord<TAccount> = storedSecurely
        ? { account, hasRefreshToken: false }
        : { account, fallbackToken: trimmed, hasRefreshToken: false }

    try {
        await userRecords.upsert(record)
    } catch (error) {
        if (storedSecurely) {
            try {
                await secureStore.deleteSecret()
            } catch {
                // best-effort — the user record failure is the real cause
            }
        }
        throw error
    }

    return { storedSecurely }
}

/**
 * Bundle-aware write. Mirrors `writeRecordWithKeyringFallback`'s order — keyring
 * first, record second — extended for two slots:
 *
 *   1. `accessStore.setSecret` (access slot). `SecureStoreUnavailableError`
 *      degrades to `fallbackToken`; any other error rethrows.
 *   2. `refreshStore.setSecret` when the bundle carries a refresh token.
 *      `SecureStoreUnavailableError` degrades to `fallbackRefreshToken`. Any
 *      other error rolls back the access slot (best-effort) before rethrowing
 *      — orphaning the access slot under a refresh-only failure would leave
 *      partial credentials behind.
 *   3. `refreshStore.deleteSecret` when the bundle has no refresh token.
 *      Clears any stale slot left from a prior bundle so the next read can't
 *      resurrect it. Best-effort.
 *   4. `userRecords.upsert(record)`. On failure, best-effort `Promise.allSettled`
 *      rollback of any keyring writes that succeeded so we never leak orphan
 *      credentials for a user the consumer never registered.
 *
 * Like the single-slot helper, default promotion is deliberately external —
 * preference, not correctness.
 */
export async function writeBundleWithKeyringFallback<TAccount extends AuthAccount>(
    options: WriteBundleOptions<TAccount>,
): Promise<WriteBundleResult> {
    const { accessStore, refreshStore, userRecords, account, bundle } = options
    const accessToken = bundle.accessToken.trim()
    const refreshToken = bundle.refreshToken?.trim()

    let accessStoredSecurely = false
    try {
        await accessStore.setSecret(accessToken)
        accessStoredSecurely = true
    } catch (error) {
        if (!(error instanceof SecureStoreUnavailableError)) throw error
    }

    let refreshStoredSecurely: boolean | undefined
    if (refreshToken) {
        try {
            await refreshStore.setSecret(refreshToken)
            refreshStoredSecurely = true
        } catch (error) {
            if (error instanceof SecureStoreUnavailableError) {
                refreshStoredSecurely = false
            } else {
                if (accessStoredSecurely) {
                    try {
                        await accessStore.deleteSecret()
                    } catch {
                        // best-effort
                    }
                }
                throw error
            }
        }
    } else {
        // Bundle has no refresh token; clear any stale slot so a previous
        // bundle's refresh token can't be read back on the next `active()`.
        try {
            await refreshStore.deleteSecret()
        } catch {
            // best-effort
        }
    }

    const record: UserRecord<TAccount> = {
        account,
        ...(accessStoredSecurely ? {} : { fallbackToken: accessToken }),
        ...(refreshToken && refreshStoredSecurely === false
            ? { fallbackRefreshToken: refreshToken }
            : {}),
        ...(bundle.accessTokenExpiresAt !== undefined
            ? { accessTokenExpiresAt: bundle.accessTokenExpiresAt }
            : {}),
        ...(bundle.refreshTokenExpiresAt !== undefined
            ? { refreshTokenExpiresAt: bundle.refreshTokenExpiresAt }
            : {}),
        hasRefreshToken: refreshToken !== undefined,
    }

    try {
        await userRecords.upsert(record)
    } catch (error) {
        const rollbacks: Promise<unknown>[] = []
        if (accessStoredSecurely) rollbacks.push(accessStore.deleteSecret())
        if (refreshStoredSecurely === true) rollbacks.push(refreshStore.deleteSecret())
        if (rollbacks.length > 0) {
            await Promise.allSettled(rollbacks)
        }
        throw error
    }

    return { accessStoredSecurely, refreshStoredSecurely }
}
