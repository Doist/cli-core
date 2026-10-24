import { CliError, getErrorMessage } from '../errors.js'
import type {
    AuthAccount,
    ExchangeResult,
    SetBundleOptions,
    TokenBundle,
    TokenStore,
} from './types.js'

export type PersistBundleOptions<TAccount extends AuthAccount> = {
    store: TokenStore<TAccount>
    account: TAccount
    bundle: TokenBundle
    /** Forwarded to `setBundle` when present. See `TokenStore.setBundle`. */
    promoteDefault?: boolean
    /** Forwarded to `setBundle` when present. See `TokenStore.setBundle`. */
    preserveStorage?: boolean
}

/**
 * Persist a bundle against any `TokenStore`. Prefers `setBundle` when the
 * store implements it; otherwise falls back to `set(account, accessToken)`
 * and silently drops refresh state. Wraps non-`CliError` failures as
 * `AUTH_STORE_WRITE_FAILED`.
 *
 * `promoteDefault` is only honoured on the `setBundle` path — the base
 * `set()` contract has no promotion control, so a custom multi-account
 * store that opts out of `setBundle` will run its own promotion policy
 * (typically first-account-wins). Multi-account stores that need
 * silent-refresh-safe selection (no re-pinning on background rotation)
 * MUST implement `setBundle`.
 */
/**
 * Build a `TokenBundle` from an `ExchangeResult`. `prev` carries the previous
 * refresh token + its expiry forward when the server didn't reissue one (most
 * don't on a refresh-grant). When the server DID return a new refresh token,
 * its expiry is whatever the server gave (or unknown) — never the old token's,
 * which would attach stale expiry metadata to a different credential.
 */
export function bundleFromExchange<TAccount extends AuthAccount>(
    exchange: ExchangeResult<TAccount>,
    prev?: TokenBundle,
): TokenBundle {
    const rotatedRefresh = exchange.refreshToken !== undefined
    const refreshToken = exchange.refreshToken ?? prev?.refreshToken
    const refreshTokenExpiresAt = rotatedRefresh
        ? exchange.refreshTokenExpiresAt
        : (exchange.refreshTokenExpiresAt ?? prev?.refreshTokenExpiresAt)
    return {
        accessToken: exchange.accessToken,
        ...(refreshToken !== undefined ? { refreshToken } : {}),
        ...(exchange.expiresAt !== undefined ? { accessTokenExpiresAt: exchange.expiresAt } : {}),
        ...(refreshTokenExpiresAt !== undefined ? { refreshTokenExpiresAt } : {}),
    }
}

export async function persistBundle<TAccount extends AuthAccount>(
    options: PersistBundleOptions<TAccount>,
): Promise<void> {
    const { store, account, bundle, promoteDefault, preserveStorage } = options
    try {
        if (store.setBundle) {
            // Omit the options arg (and each unset key) entirely so
            // presence-based handlers can distinguish "default" from
            // explicit opt-out.
            const setOptions: SetBundleOptions = {
                ...(promoteDefault !== undefined ? { promoteDefault } : {}),
                ...(preserveStorage !== undefined ? { preserveStorage } : {}),
            }
            if (Object.keys(setOptions).length === 0) {
                await store.setBundle(account, bundle)
            } else {
                await store.setBundle(account, bundle, setOptions)
            }
        } else {
            await store.set(account, bundle.accessToken)
        }
    } catch (error) {
        if (error instanceof CliError) throw error
        throw new CliError(
            'AUTH_STORE_WRITE_FAILED',
            `Failed to persist token: ${getErrorMessage(error)}`,
        )
    }
}
