import type { AuthAccount, TokenBundle, TokenStore } from './types.js'

/**
 * Persist a `TokenBundle` through whatever method the store implements.
 * Stores that opt into refresh (`createKeyringTokenStore` and any custom
 * store that exposes `setBundle`) take the bundle as-is and keep refresh +
 * expiry metadata. Simpler single-token stores fall back to
 * `set(account, bundle.accessToken)`, which discards the metadata —
 * subsequent `refreshAccessToken` calls against them will surface
 * `AUTH_REFRESH_UNAVAILABLE`, which is the correct degraded behaviour.
 *
 * Centralised here so login (`runOAuthFlow`) and refresh
 * (`refreshAccessToken`) can't drift on the policy.
 */
export async function persistBundle<TAccount extends AuthAccount>(
    store: TokenStore<TAccount>,
    account: TAccount,
    bundle: TokenBundle,
): Promise<void> {
    if (store.setBundle) {
        await store.setBundle(account, bundle)
    } else {
        await store.set(account, bundle.accessToken)
    }
}
