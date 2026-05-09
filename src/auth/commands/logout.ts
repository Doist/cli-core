import chalk from 'chalk'
import { CliError } from '../../errors.js'
import type { ViewOptions } from '../../options.js'
import type { AuthAccount, TokenStore } from '../types.js'
import { emitView } from './shared.js'

export type LogoutHandlerOptions<TAccount extends AuthAccount = AuthAccount> = {
    store: TokenStore<TAccount>
    displayName: string
}

export type LogoutCmdOptions = {
    user?: string
    all?: boolean
    json?: boolean
    ndjson?: boolean
}

export async function runLogout<TAccount extends AuthAccount>(
    options: LogoutHandlerOptions<TAccount>,
    cmd: LogoutCmdOptions,
): Promise<void> {
    const view: ViewOptions = { json: cmd.json, ndjson: cmd.ndjson }

    if (cmd.all) {
        await options.store.clear()
        emitView(view, { cleared: 'all', displayName: options.displayName }, () => [
            `${chalk.green('✓')} Cleared all stored credentials for ${options.displayName}.`,
        ])
        return
    }

    let targetId: string
    if (cmd.user) {
        // `--user`: confirm the id exists before deleting so we surface
        // AUTH_USER_NOT_FOUND instead of silently no-opping.
        const accounts = await options.store.list()
        if (!accounts.some((a) => a.id === cmd.user)) {
            throw new CliError('AUTH_USER_NOT_FOUND', `No stored account with id '${cmd.user}'.`)
        }
        targetId = cmd.user
    } else {
        // No `--user`: drop the active account. `active()` already proves the
        // account exists, so `list()` here would be a redundant read.
        const active = await options.store.active()
        if (!active) {
            throw new CliError('AUTH_NOT_LOGGED_IN', 'Not signed in. Nothing to log out.', {
                hints: ['Pass --all to clear every stored credential.'],
            })
        }
        targetId = active.account.id
    }

    await options.store.delete(targetId)
    emitView(view, { cleared: targetId, displayName: options.displayName }, () => [
        `${chalk.green('✓')} Logged out of ${options.displayName} (${chalk.dim(targetId)}).`,
    ])
}
