import type { AuthAccount, ExchangeResult, TokenBundle, TokenStore } from './types.js'

export type PersistBundleOptions = {
    /**
     * Ask a `setBundle`-implementing store to pin this account as the
     * default when nothing is pinned yet. Login (`runOAuthFlow`) sets this
     * to `true` so the first login on a fresh config auto-selects the
     * account; silent refresh (`refreshAccessToken`) omits it so a refresh
     * never mutates account selection.
     *
     * Ignored when the store doesn't implement `setBundle` — the legacy
     * `set(token)` fallback always promotes (matches its historical
     * behaviour and the single-token-store mental model).
     */
    promoteDefault?: boolean
}

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
    options: PersistBundleOptions = {},
): Promise<void> {
    if (store.setBundle) {
        // Omit the third arg entirely when no options are set — keeps
        // custom-store presence-based handling (`if (setOptions)`)
        // honest. Forwarding `{ promoteDefault: undefined }` would make
        // silent-refresh callers indistinguishable from login on the
        // option-presence axis, even though our contract documents the
        // flag as omitted on the refresh path.
        if (options.promoteDefault === undefined) {
            await store.setBundle(account, bundle)
        } else {
            await store.setBundle(account, bundle, { promoteDefault: options.promoteDefault })
        }
    } else {
        await store.set(account, bundle.accessToken)
    }
}

/**
 * Translate an `ExchangeResult` (returned by `exchangeCode` / `refreshToken`)
 * into the persisted `TokenBundle` shape. Centralised so a new field added
 * to either side (e.g. wiring `refreshTokenExpiresAt` for OAuth servers
 * that advertise it) lands in one place instead of drifting between
 * `runOAuthFlow` and `refreshAccessToken`.
 *
 * `previous` carries-forward credentials that the response didn't refresh.
 * Refresh-token rotation is the most common case: many OAuth servers
 * rotate on every refresh, others reuse — persist whatever comes back, fall
 * back to the previous when the field is absent. Pass `undefined` from the
 * login path (no previous bundle to carry forward).
 */
export function bundleFromExchange<TAccount extends AuthAccount>(
    exchange: ExchangeResult<TAccount>,
    previous?: TokenBundle,
): TokenBundle {
    return {
        accessToken: exchange.accessToken,
        refreshToken: exchange.refreshToken ?? previous?.refreshToken,
        accessTokenExpiresAt: exchange.expiresAt,
        refreshTokenExpiresAt: exchange.refreshTokenExpiresAt ?? previous?.refreshTokenExpiresAt,
    }
}
