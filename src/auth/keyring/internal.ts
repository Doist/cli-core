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
 * Outcome of resolving the refresh token for a record. Mirrors
 * `ReadAccessTokenOutcome`, plus an extra `not-present` variant for records
 * the store knows carry no refresh state (`hasRefreshToken: false`) — the
 * gate lets `activeBundle` skip the slot IPC entirely on access-only
 * records.
 */
export type ReadRefreshTokenOutcome =
    | { ok: true; token: string }
    | { ok: false; reason: 'not-present' }
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
    return readSecretSlot(secureStore, 'keyring slot returned no credential')
}

/**
 * Read + trim a keyring slot, normalising the empty / unavailable / error
 * cases. The per-record concerns (fallback field, the refresh `not-present`
 * gate, the empty-slot detail string) stay in the callers.
 */
async function readSecretSlot(
    store: SecureStore,
    emptyDetail: string,
): Promise<ReadAccessTokenOutcome> {
    try {
        const trimmed = (await store.getSecret())?.trim()
        if (trimmed) return { ok: true, token: trimmed }
        return { ok: false, reason: 'slot-empty', detail: emptyDetail }
    } catch (error) {
        if (error instanceof SecureStoreUnavailableError) {
            return { ok: false, reason: 'slot-unavailable', detail: error.message }
        }
        return { ok: false, reason: 'slot-error', detail: getErrorMessage(error) }
    }
}

/**
 * Refresh-side analogue of `readAccessTokenForRecord`. Honours the
 * `hasRefreshToken: false` gate — a record that knows it has no refresh
 * material short-circuits to `not-present` without touching the keyring.
 * Legacy records (`hasRefreshToken === undefined`) probe the slot once.
 */
export async function readRefreshTokenForRecord<TAccount extends AuthAccount>(
    record: UserRecord<TAccount>,
    refreshStore: SecureStore,
): Promise<ReadRefreshTokenOutcome> {
    if (record.hasRefreshToken === false) return { ok: false, reason: 'not-present' }

    const fallback = record.fallbackRefreshToken?.trim()
    if (fallback) return { ok: true, token: fallback }

    return readSecretSlot(refreshStore, 'keyring refresh slot returned no credential')
}
