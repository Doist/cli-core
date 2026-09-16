import { CliError } from '../errors.js'
import { type RefreshAccessTokenOptions, refreshAccessToken } from './refresh.js'
import type { AccountRef, AuthAccount, TokenBundle, TokenStore } from './types.js'

/**
 * Refresh wiring for the read-only attachers (`token` / `status`). Same shape
 * as `refreshAccessToken` minus the pieces the attacher supplies itself:
 * `store` (already an attacher option), `ref` (parsed from `--user`), and
 * `force` (these commands only refresh proactively — they never hold a 401).
 */
export type TokenRefreshOptions<TAccount extends AuthAccount = AuthAccount> = Pick<
    RefreshAccessTokenOptions<TAccount>,
    'provider' | 'lockPath' | 'skewMs' | 'handshake'
>

type RefreshedSnapshot<TAccount extends AuthAccount> = {
    token: string
    account: TAccount
    bundle: TokenBundle
}

// Internal (only the options type is re-exported). Shared by `token-view` and
// `status` so the two commands can't drift on which refresh failures fall
// back to the stored token.

/**
 * Run a proactive refresh and return the post-refresh snapshot, or `null` when
 * the caller should fall back to its plain stored-token read:
 *
 * - `AUTH_REFRESH_UNAVAILABLE` → `null`. Nothing to refresh with (no refresh
 *   token, store without bundle support, provider without `refreshToken`, no
 *   credential). The stored-read path then yields the same result it always
 *   has, including `NOT_AUTHENTICATED` / `ACCOUNT_NOT_FOUND` on an empty store.
 * - `AUTH_REFRESH_TRANSIENT` → `null` only while the stored access token is
 *   still valid (no tracked expiry, or expiry in the future). Once it has
 *   expired the error propagates: handing a script a token that is already
 *   dead is worse than a retryable failure.
 * - `AUTH_REFRESH_EXPIRED` and everything else (`AUTH_STORE_READ_FAILED`,
 *   unexpected errors) propagate unchanged.
 */
export async function refreshSnapshotOrNull<TAccount extends AuthAccount>(
    store: TokenStore<TAccount>,
    ref: AccountRef | undefined,
    refresh: TokenRefreshOptions<TAccount>,
): Promise<RefreshedSnapshot<TAccount> | null> {
    try {
        const { bundle, account } = await refreshAccessToken({ store, ref, ...refresh })
        return { token: bundle.accessToken, account, bundle }
    } catch (error) {
        if (!(error instanceof CliError)) throw error
        if (error.code === 'AUTH_REFRESH_UNAVAILABLE') return null
        if (error.code === 'AUTH_REFRESH_TRANSIENT' && (await storedTokenStillValid(store, ref))) {
            return null
        }
        throw error
    }
}

async function storedTokenStillValid<TAccount extends AuthAccount>(
    store: TokenStore<TAccount>,
    ref: AccountRef | undefined,
): Promise<boolean> {
    // `refreshAccessToken` already proved the store implements `activeBundle`
    // (it throws UNAVAILABLE otherwise, which never reaches here).
    const snapshot = await store.activeBundle?.(ref)
    if (!snapshot) return false
    const expiresAt = snapshot.bundle.accessTokenExpiresAt
    return expiresAt === undefined || expiresAt > Date.now()
}
