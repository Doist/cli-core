import type { AuthAccount } from '../types.js'
import { type SecureStore, SecureStoreUnavailableError } from './secure-store.js'
import type { UserRecord, UserRecordStore } from './types.js'

type WriteRecordOptions<TAccount extends AuthAccount> = {
    /** Per-account keyring slot, already configured by the caller (e.g. via `createSecureStore`). */
    secureStore: SecureStore
    userRecords: UserRecordStore<TAccount>
    account: TAccount
    token: string
}

type WriteRecordResult = {
    /** `true` when the secret landed in the OS keyring; `false` when the keyring was unavailable and the token was written to `fallbackToken` on the user record. */
    storedSecurely: boolean
}

/**
 * Shared keyring-then-record write used by `createKeyringTokenStore.set` and
 * `migrateLegacyAuth`. Encapsulates the order-of-operations contract that
 * matters for credential safety:
 *
 *   1. Keyring `setSecret` first. On `SecureStoreUnavailableError`, swallow
 *      the failure and record a `fallbackToken` on the user record instead.
 *      Any other error rethrows.
 *   2. `userRecords.upsert(record)`. On failure, best-effort rollback the
 *      keyring write so we don't leave an orphan credential for an account
 *      cli-core never managed to register. Original error rethrows.
 *
 * Default promotion (`setDefaultId`) is intentionally **not** in here — both
 * call sites do it best-effort outside the critical section because it is a
 * preference, not a correctness requirement, and an error there must not
 * dirty up a successful credential write.
 */
export async function writeRecordWithKeyringFallback<TAccount extends AuthAccount>(
    options: WriteRecordOptions<TAccount>,
): Promise<WriteRecordResult> {
    const { secureStore, userRecords, account, token } = options
    const trimmed = token.trim()

    let storedSecurely = false
    try {
        await secureStore.setSecret(trimmed)
        storedSecurely = true
    } catch (error) {
        if (!(error instanceof SecureStoreUnavailableError)) throw error
    }

    const record: UserRecord<TAccount> = storedSecurely
        ? { account }
        : { account, fallbackToken: trimmed }

    try {
        await userRecords.upsert(record)
    } catch (error) {
        if (storedSecurely) {
            try {
                await secureStore.deleteSecret()
            } catch {
                // best-effort — the user record failure is the real cause
            }
        }
        throw error
    }

    return { storedSecurely }
}
