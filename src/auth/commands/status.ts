import chalk from 'chalk'
import { formatJson, formatNdjson } from '../../json.js'
import type { ViewOptions } from '../../options.js'
import type { AuthAccount, AuthBackend, TokenStore } from '../types.js'

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
    const accounts = await options.store.list()
    const activeRecord = cmd.user ? await options.store.get(cmd.user) : await options.store.active()

    // The env-token override is a *runtime* concept the consumer's API client
    // honours; the store doesn't move because of it. Reflect that in `backend`
    // so `status` shows where commands will actually read from.
    const backend: AuthBackend = envTokenSet ? 'env' : await options.store.backend()

    const envelope: StatusEnvelope<TAccount> = {
        displayName: options.displayName,
        backend,
        envTokenSet,
        activeAccount: activeRecord?.account ?? null,
        accounts,
    }

    if (view.json) {
        console.log(formatJson(envelope))
        return
    }
    if (view.ndjson) {
        console.log(formatNdjson([envelope]))
        return
    }

    if (envTokenSet) {
        console.log(`${chalk.green('✓')} Using ${chalk.cyan(options.envTokenVar)} (env override)`)
        return
    }
    if (!activeRecord) {
        console.log(
            `${chalk.yellow('!')} Not signed in. Run ${chalk.cyan('login')} to authenticate.`,
        )
        return
    }
    const activeId = activeRecord.account.id
    const activeLabel = activeRecord.account.label ?? activeId
    console.log(
        `${chalk.green('✓')} Signed in to ${options.displayName} as ${chalk.cyan(activeLabel)} (${chalk.dim(activeId)})`,
    )
    console.log(`  Storage: ${chalk.dim(backend)}`)
    if (accounts.length > 1) {
        console.log(`  Accounts (${accounts.length}):`)
        for (const account of accounts) {
            const marker = account.id === activeId ? chalk.green('*') : ' '
            const label = account.label ?? account.id
            console.log(`    ${marker} ${label} ${chalk.dim(`(${account.id})`)}`)
        }
    }
}
