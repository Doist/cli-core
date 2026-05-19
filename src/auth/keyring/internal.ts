import type { AuthAccount } from '../types.js'
import { type SecureStore, SecureStoreUnavailableError } from './secure-store.js'
import type { UserRecord } from './types.js'

/**
 * Find a record by its account id. Trivial wrapper, but every caller used
 * the same shape (`(await userRecords.list()).find((r) => r.account.id ===
 * id)`) — extracting it keeps a future change to the lookup (e.g. case-
 * insensitive ids, lazy indexes) to one spot.
 */
export function findById<TAccount extends AuthAccount>(
    records: UserRecord<TAccount>[],
    id: string,
): UserRecord<TAccount> | undefined {
    return records.find((r) => r.account.id === id)
}

/**
 * Try a keyring `setSecret` and tolerate the documented offline failure.
 * Returns `true` when the secret landed in the keyring, `false` when the
 * caller should fall back to a plaintext record field. Anything other
 * than `SecureStoreUnavailableError` is rethrown — programming errors and
 * unexpected backend failures must not silently downgrade to "no keyring".
 *
 * Shared by `writeRecordWithKeyringFallback` and `migrateLegacyAuth`'s
 * tryInsert path so the offline-tolerance policy lives in one place.
 */
export async function trySetSecret(store: SecureStore, secret: string): Promise<boolean> {
    try {
        await store.setSecret(secret)
        return true
    } catch (error) {
        if (!(error instanceof SecureStoreUnavailableError)) throw error
        return false
    }
}
