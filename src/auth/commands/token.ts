import chalk from 'chalk'
import { CliError } from '../../errors.js'
import type { ViewOptions } from '../../options.js'
import type { AuthAccount, AuthProvider, TokenStore } from '../types.js'
import { emitView, persistPastedToken, readTokenFromStdin } from './shared.js'

export type TokenHandlerOptions<TAccount extends AuthAccount = AuthAccount> = {
    provider: AuthProvider<TAccount>
    store: TokenStore<TAccount>
    displayName: string
    /** Env var name that overrides the store entirely (e.g. `'TODOIST_API_TOKEN'`). */
    envTokenVar: string
}

export type TokenViewCmdOptions = {
    user?: string
    json?: boolean
    ndjson?: boolean
}

export type TokenSetCmdOptions = {
    json?: boolean
    ndjson?: boolean
}

export type TokenSetExtras = {
    /** Override the token reader (tests). Defaults to `readTokenFromStdin`. */
    readToken?: () => Promise<string>
}

/**
 * `<cli> [auth] token` — print the active token (or the one for `--user`).
 *
 * Honours the env-token override: when `<APP>_API_TOKEN` is set and `--user`
 * is not specified, it's printed verbatim and the store is not consulted.
 */
export async function runTokenView<TAccount extends AuthAccount>(
    options: TokenHandlerOptions<TAccount>,
    cmd: TokenViewCmdOptions,
): Promise<void> {
    const view: ViewOptions = { json: cmd.json, ndjson: cmd.ndjson }

    const envToken = process.env[options.envTokenVar]
    if (envToken && !cmd.user) {
        emitToken(view, envToken, 'env')
        return
    }

    const record = cmd.user ? await options.store.get(cmd.user) : await options.store.active()
    if (!record) {
        throw new CliError('AUTH_NOT_LOGGED_IN', 'No token available.', {
            hints: ['Run login first.'],
        })
    }
    emitToken(view, record.token, await options.store.backend())
}

/**
 * `<cli> [auth] token set` — read a token from piped stdin, validate it
 * against the API, and persist it as the active account in a single store
 * mutation.
 *
 * Reads from stdin (not argv) so secrets never appear in `ps`, shell
 * history, or audit logs. Errors with a hint when stdin is a TTY.
 */
export async function runTokenSet<TAccount extends AuthAccount>(
    options: TokenHandlerOptions<TAccount>,
    cmd: TokenSetCmdOptions,
    extras: TokenSetExtras = {},
): Promise<void> {
    const view: ViewOptions = { json: cmd.json, ndjson: cmd.ndjson }
    const rawToken = await (extras.readToken ?? readTokenFromStdin)()
    const account = await persistPastedToken({
        provider: options.provider,
        store: options.store,
        rawToken,
    })
    const label = account.label ?? account.id
    emitView(view, { saved: true, account, displayName: options.displayName }, () => [
        `${chalk.green('✓')} Token saved for ${options.displayName} (${chalk.cyan(label)}).`,
    ])
}

function emitToken(view: ViewOptions, token: string, source: string): void {
    emitView(view, { token, source }, () => [token])
}
