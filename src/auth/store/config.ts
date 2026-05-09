import { readConfigStrict, updateConfig } from '../../config.js'
import { CliError } from '../../errors.js'
import type {
    AuthAccount,
    AuthBackend,
    StoreMigration,
    TokenStore,
    TokenStoreSetOptions,
} from '../types.js'

export type CreateConfigTokenStoreOptions<TAccount extends AuthAccount = AuthAccount> = {
    /** Absolute path to the CLI's config file (use `getConfigPath(appName)`). */
    configPath: string
    /**
     * `true` keeps `accounts: TAccount[]` + `activeId` + `tokens: { id → token }`
     * in the config; `false` keeps a single `{ account, token }` slot.
     */
    multiUser: boolean
    /**
     * Top-level config key for the multi-user account list. Default
     * `'auth_accounts'`. Override only when migrating an existing CLI that
     * already uses a different name (Twist's `accounts`, Todoist's `users`).
     */
    accountsKey?: string
    /** Top-level key for the active-account pointer in multi-user mode. Default `'auth_active_id'`. */
    activeKey?: string
    /** Top-level key for the token map in multi-user mode. Default `'auth_tokens'`. */
    tokensKey?: string
    /** Top-level key for the single-user `{ account, token }` blob. Default `'auth'`. */
    singleKey?: string
    /**
     * One-shot migration hook. Called the first time the store reads a config
     * that lacks the target shape; if it returns a non-null result, the store
     * writes the migrated shape and serves from it. CLI-specific logic
     * (legacy field detection, API-side identity probe) lives in the hook.
     */
    migrate?: StoreMigration<TAccount>
}

type SingleSlot<TAccount> = { account: TAccount; token: string }

/**
 * Plain-JSON `TokenStore` backed by `~/.config/<app>/config.json`. Composes
 * the existing `readConfigStrict`/`updateConfig` primitives so file
 * permissions (0o600/0o700) and trailing-newline semantics are inherited.
 *
 * Single-user mode keeps `{ [singleKey]: { account, token } }`. Multi-user
 * mode keeps `{ [accountsKey]: TAccount[], [activeKey]: string,
 * [tokensKey]: Record<string, string> }` — accounts and tokens in separate
 * top-level keys so account records stay clean for status output.
 *
 * Tokens stored here are *plaintext on disk* — `createKeyringTokenStore`
 * wraps this with OS-keyring-backed storage where available.
 */
export function createConfigTokenStore<TAccount extends AuthAccount>(
    options: CreateConfigTokenStoreOptions<TAccount>,
): TokenStore<TAccount> {
    const accountsKey = options.accountsKey ?? 'auth_accounts'
    const activeKey = options.activeKey ?? 'auth_active_id'
    const tokensKey = options.tokensKey ?? 'auth_tokens'
    const singleKey = options.singleKey ?? 'auth'
    let migrationRan = false

    async function readRaw(): Promise<Record<string, unknown>> {
        const result = await readConfigStrict(options.configPath)
        return result.state === 'present' ? result.config : {}
    }

    async function maybeMigrate(raw: Record<string, unknown>): Promise<Record<string, unknown>> {
        if (migrationRan || !options.migrate) return raw
        if (options.multiUser && Array.isArray(raw[accountsKey])) {
            migrationRan = true
            return raw
        }
        if (!options.multiUser && isSingleSlot<TAccount>(raw[singleKey])) {
            migrationRan = true
            return raw
        }
        // An empty config has nothing to migrate — clean install. Skip the
        // hook to avoid noise and to keep CLI migration code free of an
        // empty-config branch.
        if (Object.keys(raw).length === 0) {
            migrationRan = true
            return raw
        }
        const migrated = await options.migrate(raw)
        migrationRan = true
        if (!migrated) return raw

        if (options.multiUser) {
            const tokens: Record<string, string> = {}
            for (const account of migrated.accounts) {
                const token = (account as Record<string, unknown>).token
                if (typeof token === 'string') tokens[account.id] = token
            }
            await updateConfig(options.configPath, {
                [accountsKey]: migrated.accounts.map(stripLegacyToken),
                [activeKey]: migrated.activeId ?? migrated.accounts[0]?.id,
                [tokensKey]: tokens,
            })
        } else {
            const account = migrated.accounts[0]
            if (account) {
                const token = (account as Record<string, unknown>).token
                await updateConfig(options.configPath, {
                    [singleKey]: {
                        account: stripLegacyToken(account),
                        token: typeof token === 'string' ? token : '',
                    },
                })
            }
        }
        return await readRaw()
    }

    async function readState(): Promise<Record<string, unknown>> {
        return await maybeMigrate(await readRaw())
    }

    function getAccounts(state: Record<string, unknown>): TAccount[] {
        const raw = state[accountsKey]
        return Array.isArray(raw) ? (raw as TAccount[]) : []
    }

    function getTokens(state: Record<string, unknown>): Record<string, string> {
        const raw = state[tokensKey]
        return isPlainObject(raw) ? (raw as Record<string, string>) : {}
    }

    function getActiveId(state: Record<string, unknown>): string | undefined {
        const raw = state[activeKey]
        return typeof raw === 'string' ? raw : undefined
    }

    return {
        async list() {
            const state = await readState()
            if (options.multiUser) return getAccounts(state)
            const slot = state[singleKey]
            return isSingleSlot<TAccount>(slot) ? [slot.account] : []
        },

        async get(id) {
            const state = await readState()
            if (options.multiUser) {
                const found = getAccounts(state).find((a) => a.id === id)
                if (!found) return null
                const token = getTokens(state)[id]
                return typeof token === 'string' ? { token, account: found } : null
            }
            const slot = state[singleKey]
            if (!isSingleSlot<TAccount>(slot) || slot.account.id !== id) return null
            return { token: slot.token, account: slot.account }
        },

        async active() {
            const state = await readState()
            if (options.multiUser) {
                const accounts = getAccounts(state)
                if (accounts.length === 0) return null
                const targetId = getActiveId(state) ?? accounts[0].id
                const found = accounts.find((a) => a.id === targetId) ?? accounts[0]
                const token = getTokens(state)[found.id]
                return typeof token === 'string' ? { token, account: found } : null
            }
            const slot = state[singleKey]
            return isSingleSlot<TAccount>(slot)
                ? { token: slot.token, account: slot.account }
                : null
        },

        async set(account, token, setOptions: TokenStoreSetOptions = {}) {
            try {
                if (options.multiUser) {
                    const state = await readState()
                    const accounts = getAccounts(state)
                    const next = [...accounts.filter((a) => a.id !== account.id), account]
                    const tokens = { ...getTokens(state), [account.id]: token }
                    const updates: Record<string, unknown> = {
                        [accountsKey]: next,
                        [tokensKey]: tokens,
                    }
                    if (setOptions.setActive || !getActiveId(state)) {
                        updates[activeKey] = account.id
                    }
                    await updateConfig(options.configPath, updates)
                } else {
                    await updateConfig(options.configPath, {
                        [singleKey]: { account, token },
                    })
                }
            } catch (error) {
                throw new CliError(
                    'AUTH_STORE_WRITE_FAILED',
                    `Failed to persist token: ${describe(error)}`,
                )
            }
        },

        async setActive(id) {
            if (!options.multiUser) return
            const state = await readState()
            if (!getAccounts(state).some((a) => a.id === id)) {
                throw new CliError('AUTH_USER_NOT_FOUND', `No stored account with id '${id}'.`)
            }
            await updateConfig(options.configPath, { [activeKey]: id })
        },

        async delete(id) {
            const state = await readState()
            if (options.multiUser) {
                const accounts = getAccounts(state).filter((a) => a.id !== id)
                const tokens = { ...getTokens(state) }
                delete tokens[id]
                const updates: Record<string, unknown> = {
                    [accountsKey]: accounts,
                    [tokensKey]: tokens,
                }
                if (getActiveId(state) === id) updates[activeKey] = accounts[0]?.id
                await updateConfig(options.configPath, updates)
            } else {
                const slot = state[singleKey]
                if (isSingleSlot<TAccount>(slot) && slot.account.id === id) {
                    await updateConfig(options.configPath, { [singleKey]: undefined })
                }
            }
        },

        async clear() {
            if (options.multiUser) {
                await updateConfig(options.configPath, {
                    [accountsKey]: [],
                    [activeKey]: undefined,
                    [tokensKey]: {},
                })
            } else {
                await updateConfig(options.configPath, { [singleKey]: undefined })
            }
        },

        async backend(): Promise<AuthBackend> {
            return 'config'
        },
    }
}

function isSingleSlot<TAccount extends AuthAccount>(value: unknown): value is SingleSlot<TAccount> {
    return (
        typeof value === 'object' &&
        value !== null &&
        'token' in value &&
        'account' in value &&
        typeof (value as SingleSlot<TAccount>).token === 'string'
    )
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stripLegacyToken<TAccount extends AuthAccount>(account: TAccount): TAccount {
    if (!('token' in account)) return account
    const { token: _token, ...rest } = account as TAccount & { token?: unknown }
    return rest as TAccount
}

function describe(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
}
