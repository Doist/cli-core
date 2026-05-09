import chalk from 'chalk'
import { CliError } from '../../errors.js'
import { formatJson, formatNdjson } from '../../json.js'
import type { ViewOptions } from '../../options.js'
import type { AuthAccount, AuthProvider, TokenStore } from '../types.js'

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
    user?: string
    json?: boolean
    ndjson?: boolean
}

/**
 * `<cli> [auth] token` — print the active token (or the one for `--user`).
 *
 * Honours the env-token override: when `<APP>_API_TOKEN` is set, it's printed
 * verbatim and the store is not consulted. The store should not race with the
 * runtime resolution path.
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
 * `<cli> [auth] token set <value>` — manually persist a token, validating it
 * against the API via `provider.acceptPastedToken`.
 */
export async function runTokenSet<TAccount extends AuthAccount>(
    options: TokenHandlerOptions<TAccount>,
    rawToken: string,
    cmd: TokenSetCmdOptions,
): Promise<void> {
    const view: ViewOptions = { json: cmd.json, ndjson: cmd.ndjson }
    if (!options.provider.acceptPastedToken) {
        throw new CliError(
            'AUTH_PROVIDER_UNSUPPORTED',
            'Token paste is not supported by the configured auth provider.',
        )
    }
    const trimmed = rawToken.trim()
    if (trimmed.length === 0) {
        throw new CliError('AUTH_INVALID_TOKEN', 'Token cannot be empty.')
    }
    const account = await options.provider.acceptPastedToken({ token: trimmed, flags: {} })
    await options.store.set(account, trimmed)
    await options.store.setActive(account.id)

    if (view.json) {
        console.log(formatJson({ saved: true, account, displayName: options.displayName }))
        return
    }
    if (view.ndjson) {
        console.log(formatNdjson([{ saved: true, account, displayName: options.displayName }]))
        return
    }
    const label = account.label ?? account.id
    console.log(
        `${chalk.green('✓')} Token saved for ${options.displayName} (${chalk.cyan(label)}).`,
    )
}

function emitToken(view: ViewOptions, token: string, source: string): void {
    if (view.json) {
        console.log(formatJson({ token, source }))
        return
    }
    if (view.ndjson) {
        console.log(formatNdjson([{ token, source }]))
        return
    }
    console.log(token)
}
