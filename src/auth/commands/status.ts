import chalk from 'chalk'
import type { ViewOptions } from '../../options.js'
import type { AuthAccount, AuthBackend, TokenStore } from '../types.js'
import { emitView } from './shared.js'

export type StatusHandlerOptions<TAccount extends AuthAccount = AuthAccount> = {
    store: TokenStore<TAccount>
    displayName: string
    /** Env var name that overrides the store entirely (e.g. `'TODOIST_API_TOKEN'`). */
    envTokenVar: string
}

export type StatusCmdOptions = {
    user?: string
    json?: boolean
    ndjson?: boolean
}

type StatusEnvelope<TAccount> = {
    displayName: string
    backend: AuthBackend
    envTokenSet: boolean
    activeAccount: TAccount | null
    accounts: TAccount[]
}

export async function runStatus<TAccount extends AuthAccount>(
    options: StatusHandlerOptions<TAccount>,
    cmd: StatusCmdOptions,
): Promise<void> {
    const view: ViewOptions = { json: cmd.json, ndjson: cmd.ndjson }
    const envTokenSet = !!process.env[options.envTokenVar]
    // The env-token override is a *runtime* concept the consumer's API client
    // honours; it short-circuits the store. `--user` deliberately ignores it
    // so an operator can still inspect a specific stored account even when an
    // env override is in effect.
    const envOverridesActive = envTokenSet && !cmd.user

    const [accounts, activeRecord, storeBackend] = await Promise.all([
        options.store.list(),
        cmd.user ? options.store.get(cmd.user) : options.store.active(),
        options.store.backend(),
    ])

    const backend: AuthBackend = envOverridesActive ? 'env' : storeBackend

    const envelope: StatusEnvelope<TAccount> = {
        displayName: options.displayName,
        backend,
        envTokenSet,
        activeAccount: activeRecord?.account ?? null,
        accounts,
    }

    emitView(view, envelope as unknown as Record<string, unknown>, () => {
        if (envOverridesActive) {
            return [`${chalk.green('✓')} Using ${chalk.cyan(options.envTokenVar)} (env override)`]
        }
        if (!activeRecord) {
            return [
                `${chalk.yellow('!')} Not signed in. Run ${chalk.cyan('login')} to authenticate.`,
            ]
        }
        const activeId = activeRecord.account.id
        const activeLabel = activeRecord.account.label ?? activeId
        const lines = [
            `${chalk.green('✓')} Signed in to ${options.displayName} as ${chalk.cyan(activeLabel)} (${chalk.dim(activeId)})`,
            `  Storage: ${chalk.dim(backend)}`,
        ]
        if (accounts.length > 1) {
            lines.push(`  Accounts (${accounts.length}):`)
            for (const account of accounts) {
                const marker = account.id === activeId ? chalk.green('*') : ' '
                const label = account.label ?? account.id
                lines.push(`    ${marker} ${label} ${chalk.dim(`(${account.id})`)}`)
            }
        }
        return lines
    })
}
