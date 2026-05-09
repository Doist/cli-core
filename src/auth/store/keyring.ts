import { CliError } from '../../errors.js'
import type { AuthAccount, AuthBackend, TokenStore, TokenStoreSetOptions } from '../types.js'

export type CreateKeyringTokenStoreOptions<TAccount extends AuthAccount = AuthAccount> = {
    /** Service name registered in the OS credential manager. Pick `'<app>-cli'`. */
    serviceName: string
    /**
     * Backing store used for account *metadata* and as the token storage
     * fallback when the keyring is unavailable. Typically a
     * `createConfigTokenStore` instance.
     */
    fallback: TokenStore<TAccount>
    /**
     * Account-name format for keyring entries. Default `(id) => 'user-${id}'`.
     * Override to keep parity with an existing CLI's installed-base.
     */
    accountName?: (id: string) => string
    /**
     * Inject a keyring module (tests). When omitted, the store dynamically
     * imports `@napi-rs/keyring` on first use.
     */
    keyringImpl?: KeyringImpl | (() => Promise<KeyringImpl>)
}

export type KeyringImpl = {
    Entry: new (
        service: string,
        account: string,
    ) => {
        getPassword(): string | null
        setPassword(password: string): void
        deletePassword(): boolean
    }
}

/**
 * `TokenStore` backed by the OS credential manager (Keychain on macOS, Secret
 * Service on Linux, Credential Manager on Windows) via `@napi-rs/keyring`.
 *
 * Account *metadata* (id, email, scope info, …) lives in the supplied
 * `fallback` store — the keyring only holds tokens. When the keyring isn't
 * available (Linux without a running secret service, locked Keychain in CI),
 * every operation transparently routes through the fallback so the CLI still
 * works, with `backend()` reflecting the actual storage in use.
 */
export function createKeyringTokenStore<TAccount extends AuthAccount>(
    options: CreateKeyringTokenStoreOptions<TAccount>,
): TokenStore<TAccount> {
    const accountName = options.accountName ?? ((id: string) => `user-${id}`)
    let resolved: KeyringImpl | null = null
    let resolutionFailed = false
    let lastBackend: AuthBackend = 'config'

    async function getKeyring(): Promise<KeyringImpl | null> {
        if (resolved) return resolved
        if (resolutionFailed) return null
        try {
            if (typeof options.keyringImpl === 'function') {
                resolved = await options.keyringImpl()
            } else if (options.keyringImpl) {
                resolved = options.keyringImpl
            } else {
                const mod = (await import('@napi-rs/keyring')) as unknown as KeyringImpl
                resolved = mod
            }
            return resolved
        } catch {
            resolutionFailed = true
            return null
        }
    }

    function tryKeyringRead(impl: KeyringImpl, id: string): string | null {
        try {
            return new impl.Entry(options.serviceName, accountName(id)).getPassword()
        } catch {
            return null
        }
    }

    function tryKeyringWrite(impl: KeyringImpl, id: string, token: string): boolean {
        try {
            new impl.Entry(options.serviceName, accountName(id)).setPassword(token)
            return true
        } catch {
            return false
        }
    }

    function tryKeyringDelete(impl: KeyringImpl, id: string): void {
        try {
            new impl.Entry(options.serviceName, accountName(id)).deletePassword()
        } catch {
            // Best-effort: keyring may already be empty.
        }
    }

    return {
        async list() {
            return options.fallback.list()
        },

        async get(id) {
            const accounts = await options.fallback.list()
            const account = accounts.find((a) => a.id === id)
            if (!account) return null

            const impl = await getKeyring()
            if (impl) {
                const token = tryKeyringRead(impl, id)
                if (typeof token === 'string' && token.length > 0) {
                    lastBackend = 'keyring'
                    return { token, account }
                }
            }
            const fallback = await options.fallback.get(id)
            if (fallback) lastBackend = 'config'
            return fallback
        },

        async active() {
            const accounts = await options.fallback.list()
            if (accounts.length === 0) return null
            const fallbackActive = await options.fallback.active()
            const id = fallbackActive?.account.id ?? accounts[0].id
            return this.get(id)
        },

        async set(account, token, setOptions: TokenStoreSetOptions = {}) {
            const impl = await getKeyring()
            if (impl && tryKeyringWrite(impl, account.id, token)) {
                lastBackend = 'keyring'
                // Persist the account record without the token in the fallback.
                await options.fallback.set(account, '', setOptions)
                return
            }
            // Keyring write failed — store everything in the fallback.
            lastBackend = 'config'
            try {
                await options.fallback.set(account, token, setOptions)
            } catch (error) {
                throw new CliError(
                    'AUTH_STORE_WRITE_FAILED',
                    `Failed to persist token to keyring or config fallback: ${describe(error)}`,
                )
            }
        },

        async setActive(id) {
            await options.fallback.setActive(id)
        },

        async delete(id) {
            const impl = await getKeyring()
            if (impl) tryKeyringDelete(impl, id)
            await options.fallback.delete(id)
        },

        async clear() {
            const accounts = await options.fallback.list()
            const impl = await getKeyring()
            if (impl) {
                for (const account of accounts) tryKeyringDelete(impl, account.id)
            }
            await options.fallback.clear()
        },

        async backend(): Promise<AuthBackend> {
            return lastBackend
        },
    }
}

function describe(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
}
