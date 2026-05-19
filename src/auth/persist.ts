import { CliError, getErrorMessage } from '../errors.js'
import type { AuthAccount, TokenBundle, TokenStore } from './types.js'

export type PersistBundleOptions<TAccount extends AuthAccount> = {
    store: TokenStore<TAccount>
    account: TAccount
    bundle: TokenBundle
    /** Forwarded to `setBundle` when present. See `TokenStore.setBundle`. */
    promoteDefault?: boolean
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
export async function persistBundle<TAccount extends AuthAccount>(
    options: PersistBundleOptions<TAccount>,
): Promise<void> {
    const { store, account, bundle, promoteDefault } = options
    try {
        if (store.setBundle) {
            // Omit the options arg entirely when unset so presence-based
            // handlers can distinguish "default" from explicit opt-out.
            if (promoteDefault === undefined) {
                await store.setBundle(account, bundle)
            } else {
                await store.setBundle(account, bundle, { promoteDefault })
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
