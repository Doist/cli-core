import { CliError } from '../../errors.js'
import type { AuthAccount, TokenBundle } from '../types.js'
import { type SecureStore, SecureStoreUnavailableError } from './secure-store.js'
import type { CredentialStore, UserRecord, UserRecordStore } from './types.js'

type WriteRecordOptions<TAccount extends AuthAccount> = {
    /** Per-account keyring slot, already configured by the caller (e.g. via `createSecureStore`). */
    secureStore: SecureStore
    /**
     * Optional refresh-token keyring slot. When supplied, any orphan refresh
     * material from a prior `setBundle` is wiped best-effort AFTER the user
     * record is upserted (see the deferred-cleanup contract on
     * `writeBundleWithKeyringFallback`).
     */
    refreshStore?: SecureStore
    userRecords: UserRecordStore<TAccount>
    account: TAccount
    token: string
    credentialStore?: CredentialStore
}

type WriteRecordResult = {
    /** `true` when the secret landed in the OS keyring; `false` when it was written to `fallbackToken` on the user record. */
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
    credentialStore?: CredentialStore
}

type WriteBundleResult = {
    /** `true` when the access token landed in the OS keyring; `false` when it was written to `fallbackToken`. */
    accessStoredSecurely: boolean
    /**
     * `true` when a refresh token landed in the OS keyring. `false` when it
     * was written to `fallbackRefreshToken`. `undefined` when the bundle
     * carried no refresh token (nothing to store).
     */
    refreshStoredSecurely: boolean | undefined
}

/**
 * Single-token write. Thin wrapper over `writeBundleWithKeyringFallback`
 * passing a refresh-less bundle, so trim/validate, access-slot storage,
 * upsert rollback, and the deferred refresh-slot wipe all share one
 * implementation.
 *
 * `refreshStore` is optional purely for legacy callers (`migrateLegacyAuth`)
 * that don't have one wired; the migrate path never had refresh state so
 * skipping the wipe is correct there.
 */
export async function writeRecordWithKeyringFallback<TAccount extends AuthAccount>(
    options: WriteRecordOptions<TAccount>,
): Promise<WriteRecordResult> {
    const { secureStore, refreshStore, userRecords, account, token, credentialStore } = options

    const { accessStoredSecurely } = await writeBundleWithKeyringFallback({
        accessStore: secureStore,
        // No-op store when the caller didn't wire one — the deferred wipe
        // becomes inert and we don't accidentally create a refresh slot
        // for legacy/migrate paths.
        refreshStore: refreshStore ?? NOOP_SECURE_STORE,
        userRecords,
        account,
        bundle: { accessToken: token },
        credentialStore,
    })

    return { storedSecurely: accessStoredSecurely }
}

/**
 * Two-slot write. Order: access slot → refresh slot → upsert → deferred
 * refresh wipe.
 *
 *   1. Validate `bundle.accessToken` (non-empty after trim).
 *   2. Under `'system'` or `'fallback'`, `accessStore.setSecret` runs.
 *      `'fallback'` degrades a `SecureStoreUnavailableError` to
 *      `fallbackToken`; `'system'` rejects it. `'plaintext'` writes the
 *      fallback field directly without calling the keyring.
 *   3. Under `'system'` or `'fallback'`, `refreshStore.setSecret` runs when
 *      `bundle.refreshToken` is present. Under `'fallback'`,
 *      `SecureStoreUnavailableError` degrades to `fallbackRefreshToken`; under
 *      `'system'`, it rolls back a successful access-slot write before
 *      rejecting. A non-keyring failure has the same rollback behavior.
 *   4. `userRecords.upsert(record)`. On failure, best-effort
 *      `Promise.allSettled` rollback of any slot writes that succeeded.
 *   5. Only after a successful non-plaintext upsert: if the bundle has no
 *      refresh token, wipe any orphan slot from a prior `setBundle`
 *      (best-effort). Doing this BEFORE the upsert would lose refresh state if
 *      the upsert then rejected — the new record's `hasRefreshToken` would
 *      still claim false but the old slot would be gone with no rollback path.
 *
 * Default promotion is external — preference, not correctness, and an
 * error there must not dirty up a successful credential write.
 */
export async function writeBundleWithKeyringFallback<TAccount extends AuthAccount>(
    options: WriteBundleOptions<TAccount>,
): Promise<WriteBundleResult> {
    const { accessStore, refreshStore, userRecords, account, bundle } = options
    const credentialStore = options.credentialStore ?? 'fallback'
    const accessToken = bundle.accessToken.trim()
    if (!accessToken) {
        throw new CliError(
            'AUTH_STORE_WRITE_FAILED',
            'Refusing to persist a bundle with an empty access token.',
        )
    }
    const refreshToken = bundle.refreshToken?.trim()

    let accessStoredSecurely = false
    if (credentialStore !== 'plaintext') {
        try {
            await accessStore.setSecret(accessToken)
            accessStoredSecurely = true
        } catch (error) {
            if (!(error instanceof SecureStoreUnavailableError)) throw error
            if (credentialStore === 'system') throw credentialStoreUnavailableError()
        }
    }

    let refreshStoredSecurely: boolean | undefined
    if (refreshToken && credentialStore !== 'plaintext') {
        try {
            await refreshStore.setSecret(refreshToken)
            refreshStoredSecurely = true
        } catch (error) {
            if (error instanceof SecureStoreUnavailableError && credentialStore === 'fallback') {
                refreshStoredSecurely = false
            } else {
                if (accessStoredSecurely) {
                    try {
                        await accessStore.deleteSecret()
                    } catch {
                        // best-effort
                    }
                }
                if (error instanceof SecureStoreUnavailableError) {
                    throw credentialStoreUnavailableError()
                }
                throw error
            }
        }
    } else if (refreshToken) {
        refreshStoredSecurely = false
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

    // Deferred: wipe any orphan refresh slot from a prior setBundle now
    // that the new record (with `hasRefreshToken: false`) is durable. If
    // this fails the gate already prevents readers from consulting it; the
    // worst case is a stale keyring entry that `clear()` will pick up.
    if (!refreshToken && credentialStore !== 'plaintext') {
        try {
            await refreshStore.deleteSecret()
        } catch {
            // best-effort
        }
    }

    return { accessStoredSecurely, refreshStoredSecurely }
}

function credentialStoreUnavailableError(): CliError {
    return new CliError(
        'AUTH_STORE_WRITE_FAILED',
        'The system credential manager could not store the credential.',
        {
            hints: [
                'Make the system credential manager available and retry.',
                'Configure plaintext credential storage explicitly to store the credential in the config file.',
            ],
        },
    )
}

/**
 * Build a `UserRecord` for an access-only credential (no refresh state).
 * Used by `migrateLegacyAuth`'s Phase 1 / Phase 2 record writes; both call
 * sites then agree on the explicit `hasRefreshToken: false` that lets
 * future bundle-aware readers skip the refresh-slot IPC.
 *
 * `writeBundleWithKeyringFallback` builds its own record shape inline
 * because the bundle path also carries expiry fields; the structural
 * overlap is the `hasRefreshToken: false` + optional `fallbackToken`
 * pair, which is what this helper isolates.
 */
export function buildSingleTokenRecord<TAccount extends AuthAccount>(
    account: TAccount,
    fallbackToken?: string,
): UserRecord<TAccount> {
    return {
        account,
        ...(fallbackToken ? { fallbackToken } : {}),
        hasRefreshToken: false,
    }
}

const NOOP_SECURE_STORE: SecureStore = {
    async getSecret() {
        return null
    },
    async setSecret() {
        // no-op
    },
    async deleteSecret() {
        return false
    },
}
