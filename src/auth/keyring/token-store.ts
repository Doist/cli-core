import { CliError } from '../../errors.js'
import type { AccountRef, AuthAccount, TokenStore } from '../types.js'
import {
    createSecureStore,
    SECURE_STORE_DESCRIPTION,
    SecureStoreUnavailableError,
    type SecureStore,
} from './secure-store.js'
import type { TokenStorageResult, UserRecord, UserRecordStore } from './types.js'

export type CreateKeyringTokenStoreOptions<TAccount extends AuthAccount> = {
    /** Application identifier used for every keyring entry (e.g. `'todoist-cli'`). */
    serviceName: string
    /** Consumer-owned per-user record store (typically backed by their config file). */
    userRecords: UserRecordStore<TAccount>
    /**
     * Builds the keyring `account` slug for a user id. Defaults to
     * `user-${id}`. Override only when migrating from a legacy naming scheme.
     */
    accountForUser?: (id: string) => string
    /**
     * Decides whether an account matches an `AccountRef` supplied via
     * `--user <ref>`. Defaults to id-or-label equality. Override to broaden
     * (e.g. case-insensitive email, alias map).
     */
    matchAccount?: (account: TAccount, ref: AccountRef) => boolean
}

export type KeyringTokenStore<TAccount extends AuthAccount> = TokenStore<TAccount> & {
    /** Storage result from the most recent `set()` call, or `undefined` before any. */
    getLastStorageResult(): TokenStorageResult | undefined
    /** Storage result from the most recent `clear()` call, or `undefined` before any. */
    getLastClearResult(): TokenStorageResult | undefined
}

const DEFAULT_ACCOUNT_FOR_USER = (id: string) => `user-${id}`
const DEFAULT_MATCH_ACCOUNT = <TAccount extends AuthAccount>(
    account: TAccount,
    ref: AccountRef,
): boolean => account.id === ref || account.label === ref

/**
 * Multi-account `TokenStore` that keeps secrets in the OS credential manager
 * and per-user metadata in the consumer's `UserRecordStore`. Falls back to a
 * plaintext token on the user record when the keyring is unreachable (WSL
 * without D-Bus, missing native binary, locked Keychain, …) so the CLI keeps
 * working at the cost of a visible warning.
 *
 * Write order is deliberate: keyring first, then `userRecords.upsert`. If the
 * upsert fails after a successful keyring write, the keyring entry is rolled
 * back via `deleteSecret()` to avoid orphan credentials for a user that
 * cli-core never managed to record.
 *
 * Clear order is the inverse: record removal first (the source of truth that
 * the rest of the CLI reads), then keyring delete. A keyring delete failure
 * after a successful removal is downgraded to a warning — the orphan secret
 * is harmless because no record references it anymore.
 */
export function createKeyringTokenStore<TAccount extends AuthAccount>(
    options: CreateKeyringTokenStoreOptions<TAccount>,
): KeyringTokenStore<TAccount> {
    const { serviceName, userRecords } = options
    const accountForUser = options.accountForUser ?? DEFAULT_ACCOUNT_FOR_USER
    const matchAccount = options.matchAccount ?? DEFAULT_MATCH_ACCOUNT

    let lastStorageResult: TokenStorageResult | undefined
    let lastClearResult: TokenStorageResult | undefined

    function secureStoreFor(id: string): SecureStore {
        return createSecureStore({ serviceName, account: accountForUser(id) })
    }

    async function findByRef(ref: AccountRef): Promise<UserRecord<TAccount> | null> {
        const all = await userRecords.list()
        return all.find((record) => matchAccount(record.account, ref)) ?? null
    }

    async function resolveDefaultRecord(): Promise<UserRecord<TAccount> | null> {
        const defaultId = await userRecords.getDefaultId()
        if (defaultId) {
            const record = await userRecords.getById(defaultId)
            if (record) return record
        }
        const all = await userRecords.list()
        if (all.length === 1) return all[0]
        return null
    }

    async function readToken(record: UserRecord<TAccount>): Promise<string | null> {
        if (record.fallbackToken?.trim()) {
            return record.fallbackToken.trim()
        }
        try {
            const token = await secureStoreFor(record.id).getSecret()
            return token?.trim() ? token.trim() : null
        } catch (error) {
            if (error instanceof SecureStoreUnavailableError) return null
            throw error
        }
    }

    return {
        async active(ref) {
            const record = ref === undefined ? await resolveDefaultRecord() : await findByRef(ref)
            if (!record) return null

            const token = await readToken(record)
            if (!token) return null
            return { token, account: record.account }
        },

        async set(account, token) {
            const trimmed = token.trim()
            const secureStore = secureStoreFor(account.id)

            let storedSecurely = false
            try {
                await secureStore.setSecret(trimmed)
                storedSecurely = true
            } catch (error) {
                if (!(error instanceof SecureStoreUnavailableError)) throw error
            }

            const record: UserRecord<TAccount> = storedSecurely
                ? { id: account.id, account }
                : { id: account.id, account, fallbackToken: trimmed }

            try {
                await userRecords.upsert(record)
            } catch (error) {
                // The user record is the source of truth. If we can't write it,
                // a stranded keyring entry would leak credentials for an account
                // cli-core never managed to register. Best-effort rollback, then
                // re-raise the original error so the caller sees the real cause.
                if (storedSecurely) {
                    try {
                        await secureStore.deleteSecret()
                    } catch {
                        // ignore — the user record failure is what matters
                    }
                }
                throw error
            }

            const existingDefault = await userRecords.getDefaultId()
            if (!existingDefault) {
                await userRecords.setDefaultId(account.id)
            }

            lastStorageResult = storedSecurely
                ? { storage: 'secure-store' }
                : {
                      storage: 'config-file',
                      warning: buildFallbackWarning(
                          'token saved as plaintext in',
                          userRecords.describeLocation(),
                      ),
                  }
        },

        async clear(ref) {
            const record = ref === undefined ? await resolveDefaultRecord() : await findByRef(ref)
            if (!record) {
                lastClearResult = undefined
                return
            }

            await userRecords.remove(record.id)

            const currentDefault = await userRecords.getDefaultId()
            if (currentDefault === record.id) {
                await userRecords.setDefaultId(null)
            }

            // No keyring entry to delete when the token was already plaintext.
            if (record.fallbackToken !== undefined) {
                lastClearResult = {
                    storage: 'config-file',
                    warning: buildFallbackWarning(
                        'local auth state cleared in',
                        userRecords.describeLocation(),
                    ),
                }
                return
            }

            try {
                await secureStoreFor(record.id).deleteSecret()
                lastClearResult = { storage: 'secure-store' }
            } catch (error) {
                if (!(error instanceof SecureStoreUnavailableError)) throw error
                lastClearResult = {
                    storage: 'config-file',
                    warning: buildFallbackWarning(
                        'local auth state cleared in',
                        userRecords.describeLocation(),
                    ),
                }
            }
        },

        async list() {
            const all = await userRecords.list()
            const defaultId = await userRecords.getDefaultId()
            return all.map((record) => ({
                account: record.account,
                isDefault: record.id === defaultId,
            }))
        },

        async setDefault(ref) {
            const record = await findByRef(ref)
            if (!record) {
                throw new CliError('ACCOUNT_NOT_FOUND', `No stored account matches "${ref}".`)
            }
            await userRecords.setDefaultId(record.id)
        },

        getLastStorageResult() {
            return lastStorageResult
        },

        getLastClearResult() {
            return lastClearResult
        },
    }
}

function buildFallbackWarning(action: string, location: string): string {
    return `${SECURE_STORE_DESCRIPTION} unavailable; ${action} ${location}`
}
