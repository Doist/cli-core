import { CliError } from '../../errors.js'
import type { AuthAccount, TokenBundle } from '../types.js'
import { type SecureStore, SecureStoreUnavailableError } from './secure-store.js'
import type { UserRecord, UserRecordStore } from './types.js'

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
 * Single-token write. Thin wrapper over `writeBundleWithKeyringFallback`
 * passing a refresh-less bundle, so trim/validate, access-slot fallback,
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
    const { secureStore, refreshStore, userRecords, account, token } = options

    const { accessStoredSecurely } = await writeBundleWithKeyringFallback({
        accessStore: secureStore,
        // No-op store when the caller didn't wire one — the deferred wipe
        // becomes inert and we don't accidentally create a refresh slot
        // for legacy/migrate paths.
        refreshStore: refreshStore ?? NOOP_SECURE_STORE,
        userRecords,
        account,
        bundle: { accessToken: token },
    })

    return { storedSecurely: accessStoredSecurely }
}

/**
 * Two-slot write. Order: access slot → refresh slot → upsert → deferred
 * refresh wipe.
 *
 *   1. Validate `bundle.accessToken` (non-empty after trim).
 *   2. `accessStore.setSecret`. `SecureStoreUnavailableError` degrades to
 *      `fallbackToken` on the record; any other error rethrows.
 *   3. `refreshStore.setSecret` when `bundle.refreshToken` is present.
 *      `SecureStoreUnavailableError` degrades to `fallbackRefreshToken`. A
 *      non-keyring failure rolls back the access slot before rethrowing
 *      (no partial credentials left behind for an unregistered user).
 *   4. `userRecords.upsert(record)`. On failure, best-effort
 *      `Promise.allSettled` rollback of any slot writes that succeeded.
 *   5. Only after a successful upsert: if the bundle has no refresh token,
 *      wipe any orphan slot from a prior `setBundle` (best-effort). Doing
 *      this BEFORE the upsert would lose refresh state if the upsert then
 *      rejected — the new record's `hasRefreshToken` would still claim
 *      false but the old slot would be gone with no rollback path.
 *
 * Default promotion is external — preference, not correctness, and an
 * error there must not dirty up a successful credential write.
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
    if (!refreshToken) {
        try {
            await refreshStore.deleteSecret()
        } catch {
            // best-effort
        }
    }

    return { accessStoredSecurely, refreshStoredSecurely }
}

/**
 * Build a `UserRecord` for an access-only credential (no refresh state).
 * Shared by `writeBundleWithKeyringFallback`'s refresh-less write path and
 * by the migration's Phase 1 / Phase 2 record writes, so all three paths
 * agree on the field shape — most importantly the explicit
 * `hasRefreshToken: false` that lets future bundle-aware readers skip the
 * refresh-slot IPC.
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
