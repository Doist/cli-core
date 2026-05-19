import { CliError } from '../../errors.js'
import type { AuthAccount, TokenBundle } from '../types.js'
import { type SecureStore, SecureStoreUnavailableError } from './secure-store.js'
import type { UserRecord, UserRecordStore } from './types.js'

type WriteRecordOptions<TAccount extends AuthAccount> = {
    /** Per-account keyring slot, already configured by the caller (e.g. via `createSecureStore`). */
    secureStore: SecureStore
    /** Optional refresh-token keyring slot to wipe alongside the access write. */
    refreshStore?: SecureStore
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

type WriteBundleResult = {
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
    const { secureStore, refreshStore, userRecords, account, token } = options
    const trimmed = token.trim()
    if (!trimmed) {
        throw new CliError('AUTH_STORE_WRITE_FAILED', 'Refusing to persist an empty access token.')
    }

    let storedSecurely = false
    try {
        await secureStore.setSecret(trimmed)
        storedSecurely = true
    } catch (error) {
        if (!(error instanceof SecureStoreUnavailableError)) throw error
    }

    // Wipe any orphan refresh slot so a prior `setBundle` can't leave
    // material behind after a `set()` replaces the credential. Best-effort:
    // the cleanup is a security hardening on the contract's
    // "replacing any previous entry" promise, not a hard correctness
    // requirement (the `hasRefreshToken: false` gate already prevents
    // readers from consulting it).
    if (refreshStore) {
        try {
            await refreshStore.deleteSecret()
        } catch {
            // best-effort
        }
    }

    // Single-token path; assert no refresh state so `active()` skips the
    // refresh-slot IPC instead of probing on every command.
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
 * Two-slot variant of `writeRecordWithKeyringFallback`. Order: access slot →
 * refresh slot → upsert. `SecureStoreUnavailableError` on either slot degrades
 * to the matching `fallback*Token` field. A non-keyring refresh-slot failure
 * rolls back the access slot before rethrowing (no partial credentials). An
 * upsert failure rolls back both slots via `Promise.allSettled` (no orphan
 * credentials for an unregistered user). When the bundle has no refresh
 * token, the refresh slot is wiped best-effort so a prior bundle can't
 * resurface on the next read. Default promotion is external (same as the
 * single-slot helper).
 */
export async function writeBundleWithKeyringFallback<TAccount extends AuthAccount>(
    options: WriteBundleOptions<TAccount>,
): Promise<WriteBundleResult> {
    const { accessStore, refreshStore, userRecords, account, bundle } = options
    const accessToken = bundle.accessToken.trim()
    if (!accessToken) {
        throw new CliError(
            'AUTH_STORE_WRITE_FAILED',
            'Refusing to persist a bundle with an empty access token.',
        )
    }
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
        hasRefreshToken: Boolean(refreshToken),
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
