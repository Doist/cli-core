import chalk from 'chalk'
import { CliError } from '../../errors.js'
import { formatJson, formatNdjson } from '../../json.js'
import type { ViewOptions } from '../../options.js'
import type { AuthAccount, TokenStore } from '../types.js'

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
        emit(view, { cleared: 'all', displayName: options.displayName }, [
            `${chalk.green('✓')} Cleared all stored credentials for ${options.displayName}.`,
        ])
        return
    }

    let targetId: string | undefined
    if (cmd.user) {
        targetId = cmd.user
    } else {
        const active = await options.store.active()
        if (!active) {
            throw new CliError('AUTH_NOT_LOGGED_IN', 'Not signed in. Nothing to log out.', {
                hints: ['Pass --all to clear every stored credential.'],
            })
        }
        targetId = active.account.id
    }

    const before = await options.store.list()
    if (!before.some((a) => a.id === targetId)) {
        throw new CliError('AUTH_USER_NOT_FOUND', `No stored account with id '${targetId}'.`)
    }

    await options.store.delete(targetId)
    emit(view, { cleared: targetId, displayName: options.displayName }, [
        `${chalk.green('✓')} Logged out of ${options.displayName} (${chalk.dim(targetId)}).`,
    ])
}

function emit(view: ViewOptions, payload: Record<string, unknown>, lines: string[]): void {
    if (view.json) {
        console.log(formatJson(payload))
        return
    }
    if (view.ndjson) {
        console.log(formatNdjson([payload]))
        return
    }
    for (const line of lines) console.log(line)
}
