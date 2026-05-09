import { readConfigStrict, updateConfig } from '../../config.js'
import { CliError } from '../../errors.js'
import type { AuthAccount, AuthBackend, TokenStore } from '../types.js'

export type CreateConfigTokenStoreOptions = {
    /** Absolute path to the CLI's config file (use `getConfigPath(appName)`). */
    configPath: string
    /** Top-level key for the `{ account, token }` blob. Default `'auth'`. */
    storageKey?: string
}

type StoredAuth<TAccount> = { account: TAccount; token: string }

/**
 * Single-user `TokenStore` backed by `~/.config/<app>/config.json`. Composes
 * `readConfigStrict` / `updateConfig` so file permissions (0o600 / 0o700) and
 * trailing-newline semantics are inherited.
 *
 * Tokens are stored *plaintext on disk* — for OS-keychain-backed storage,
 * implement the `TokenStore` interface directly. Multi-account variants are
 * also expected to be implemented per CLI today.
 */
export function createConfigTokenStore<TAccount extends AuthAccount>(
    options: CreateConfigTokenStoreOptions,
): TokenStore<TAccount> {
    const storageKey = options.storageKey ?? 'auth'

    async function readSlot(): Promise<StoredAuth<TAccount> | null> {
        const result = await readConfigStrict(options.configPath)
        if (result.state !== 'present') return null
        const slot = result.config[storageKey]
        return isStoredAuth<TAccount>(slot) ? slot : null
    }

    return {
        async active() {
            return await readSlot()
        },

        async set(account, token) {
            try {
                await updateConfig(options.configPath, { [storageKey]: { account, token } })
            } catch (error) {
                throw new CliError(
                    'AUTH_STORE_WRITE_FAILED',
                    `Failed to persist token: ${describe(error)}`,
                )
            }
        },

        async clear() {
            await updateConfig(options.configPath, { [storageKey]: undefined })
        },

        async backend(): Promise<AuthBackend> {
            return 'config'
        },
    }
}

function isStoredAuth<TAccount extends AuthAccount>(value: unknown): value is StoredAuth<TAccount> {
    return (
        typeof value === 'object' &&
        value !== null &&
        'token' in value &&
        'account' in value &&
        typeof (value as StoredAuth<TAccount>).token === 'string'
    )
}

function describe(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
}
