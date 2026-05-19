import { getErrorMessage } from '../../errors.js'
import type { AuthAccount } from '../types.js'
import { type SecureStore, SecureStoreUnavailableError } from './secure-store.js'
import type { UserRecord } from './types.js'

/**
 * Outcome of resolving the access token for a record. Callers map the
 * structured failure variants to whatever error contract they expose —
 * `KeyringTokenStore.active()` throws `CliError('AUTH_STORE_READ_FAILED', …)`;
 * `migrateLegacyAuth` translates each variant into a `MigrateSkipReason`.
 */
export type ReadAccessTokenOutcome =
    | { ok: true; token: string }
    | { ok: false; reason: 'slot-empty' | 'slot-unavailable' | 'slot-error'; detail: string }

/**
 * `fallbackToken` first (so an offline-keyring write is preferred over a
 * stale slot), then the keyring slot. Single-source for "is this record
 * readable in the current environment" — `KeyringTokenStore.active()` and
 * `migrateLegacyAuth`'s readability probe both call this.
 */
export async function readAccessTokenForRecord<TAccount extends AuthAccount>(
    record: UserRecord<TAccount>,
    secureStore: SecureStore,
): Promise<ReadAccessTokenOutcome> {
    const fallback = record.fallbackToken?.trim()
    if (fallback) return { ok: true, token: fallback }

    try {
        const raw = await secureStore.getSecret()
        const trimmed = raw?.trim()
        if (trimmed) return { ok: true, token: trimmed }
        return {
            ok: false,
            reason: 'slot-empty',
            detail: 'keyring slot returned no credential',
        }
    } catch (error) {
        if (error instanceof SecureStoreUnavailableError) {
            return { ok: false, reason: 'slot-unavailable', detail: error.message }
        }
        return { ok: false, reason: 'slot-error', detail: getErrorMessage(error) }
    }
}
