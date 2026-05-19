import { CliError, getErrorMessage } from '../errors.js'
import type { AuthAccount, TokenBundle, TokenStore } from './types.js'

export type PersistBundleOptions<TAccount extends AuthAccount> = {
    store: TokenStore<TAccount>
    account: TAccount
    bundle: TokenBundle
    /**
     * Forwarded to `TokenStore.setBundle` when present. First-login persistence
     * sets `true`; silent refresh omits the flag so a background rotation
     * can't mutate account selection.
     */
    promoteDefault?: boolean
}

/**
 * Persist a `TokenBundle` against any `TokenStore`, regardless of whether the
 * store opted into the optional `setBundle` method. Stores that implement
 * `setBundle` receive the full bundle (refresh token + expiries). Stores that
 * don't are handed `bundle.accessToken` via the legacy `set(account, token)`
 * path — refresh state is silently dropped because the store can't hold it.
 *
 * Throws `AUTH_STORE_WRITE_FAILED` on non-`CliError` failures so callers get
 * one uniform error code regardless of which path the store used.
 */
export async function persistBundle<TAccount extends AuthAccount>(
    options: PersistBundleOptions<TAccount>,
): Promise<void> {
    const { store, account, bundle, promoteDefault } = options
    try {
        if (store.setBundle) {
            // Forward `promoteDefault` only when the caller actually set it.
            // Some store implementations may distinguish "default omitted"
            // (preserve current default behaviour) from
            // "default: false" (explicit opt-out) via argument presence.
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
