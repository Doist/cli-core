import { CliError } from '../errors.js'
import {
    DEFAULT_SKEW_MS,
    type RefreshAccessTokenOptions,
    isAccessTokenExpired,
    needsRefresh,
    refreshAccessToken,
} from './refresh.js'
import type {
    AccountRef,
    ActiveBundleSnapshot,
    AuthAccount,
    TokenBundle,
    TokenStore,
} from './types.js'

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
 * Read the bundle, rotate it if a refresh is due, and return the resulting
 * snapshot. Returns `null` when this path can't produce one and the caller
 * should run its plain stored read instead: the store lacks bundle support,
 * the provider has no `refreshToken`, or nothing matched `ref` (so the
 * caller keeps its own `NOT_AUTHENTICATED` / `ACCOUNT_NOT_FOUND` handling).
 *
 * The pre-flight here mirrors `refreshAccessToken`'s own, so that helper is
 * only invoked when a rotation is genuinely due. Any error it then raises —
 * including `AUTH_REFRESH_UNAVAILABLE` from the provider itself (a DCR
 * handshake missing `clientId`, `oauth4webapi` not installed) — is a wiring
 * fault the consumer must see, not a reason to print a possibly-dead token.
 * The one exception is `AUTH_REFRESH_TRANSIENT` while the stored access
 * token is still valid: the caller gets the stored snapshot and the next
 * invocation retries. Once it has expired the transient error propagates,
 * since a retryable failure beats handing a script a token that no longer
 * works.
 */
export async function refreshSnapshotOrNull<TAccount extends AuthAccount>(
    store: TokenStore<TAccount>,
    ref: AccountRef | undefined,
    refresh: TokenRefreshOptions<TAccount>,
): Promise<RefreshedSnapshot<TAccount> | null> {
    if (!store.activeBundle || !store.setBundle || !refresh.provider.refreshToken) return null
    const snapshot = await store.activeBundle(ref)
    if (!snapshot) return null

    const skewMs = refresh.skewMs ?? DEFAULT_SKEW_MS
    if (!snapshot.bundle.refreshToken || !needsRefresh(snapshot.bundle, skewMs)) {
        return fromBundle(snapshot)
    }

    try {
        const { bundle, account } = await refreshAccessToken({ store, ref, ...refresh })
        return { token: bundle.accessToken, account, bundle }
    } catch (error) {
        if (
            error instanceof CliError &&
            error.code === 'AUTH_REFRESH_TRANSIENT' &&
            !isAccessTokenExpired(snapshot.bundle)
        ) {
            return fromBundle(snapshot)
        }
        throw error
    }
}

function fromBundle<TAccount extends AuthAccount>(
    snapshot: ActiveBundleSnapshot<TAccount>,
): RefreshedSnapshot<TAccount> {
    return {
        token: snapshot.bundle.accessToken,
        account: snapshot.account,
        bundle: snapshot.bundle,
    }
}
