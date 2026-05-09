import chalk from 'chalk'
import { CliError } from '../../errors.js'
import { formatJson, formatNdjson } from '../../json.js'
import type { ViewOptions } from '../../options.js'
import { runOAuthFlow } from '../flow.js'
import type {
    AuthAccount,
    AuthProvider,
    ErrorContext,
    SuccessContext,
    TokenStore,
} from '../types.js'

export type LoginHandlerOptions<TAccount extends AuthAccount = AuthAccount> = {
    provider: AuthProvider<TAccount>
    store: TokenStore<TAccount>
    displayName: string
    /** Resolve scope list per call (so `--read-only` and `loginFlags` can reshape it). */
    resolveScopes: (ctx: { readOnly: boolean; flags: Record<string, unknown> }) => string[]
    callbackPort: { preferred: number; fallbackCount?: number }
    renderSuccess: (ctx: SuccessContext) => string
    renderError: (ctx: ErrorContext) => string
    openBrowser?: (url: string) => Promise<void>
    withSpinner?: <T>(
        opts: { text: string; color?: 'blue' | 'cyan' },
        op: () => Promise<T>,
    ) => Promise<T>
}

export type LoginCmdOptions = {
    readOnly?: boolean
    token?: string
    callbackPort?: number
    user?: string
    json?: boolean
    ndjson?: boolean
    [key: string]: unknown
}

/**
 * Run the `<cli> [auth] login` action. Either drives the full OAuth flow or
 * routes a `--token <value>` paste through `provider.acceptPastedToken`.
 */
export async function runLogin<TAccount extends AuthAccount>(
    options: LoginHandlerOptions<TAccount>,
    cmd: LoginCmdOptions,
): Promise<void> {
    const view: ViewOptions = { json: cmd.json, ndjson: cmd.ndjson }
    const readOnly = Boolean(cmd.readOnly)
    const flags = stripReservedFlags(cmd)

    if (cmd.token) {
        if (!options.provider.acceptPastedToken) {
            throw new CliError(
                'AUTH_PROVIDER_UNSUPPORTED',
                '--token is not supported by the configured auth provider.',
            )
        }
        const account = await options.provider.acceptPastedToken({ token: cmd.token, flags })
        await options.store.set(account, cmd.token)
        await options.store.setActive(account.id)
        emitLogin(view, options.displayName, account)
        return
    }

    const scopes = options.resolveScopes({ readOnly, flags })
    const port = cmd.callbackPort ?? options.callbackPort.preferred

    const runner = options.withSpinner
        ? options.withSpinner({ text: 'Waiting for authorization...', color: 'blue' }, () =>
              runOAuthFlow<TAccount>({
                  provider: options.provider,
                  store: options.store,
                  displayName: options.displayName,
                  scopes,
                  readOnly,
                  flags,
                  preferredPort: port,
                  portFallbackCount: options.callbackPort.fallbackCount,
                  renderSuccess: options.renderSuccess,
                  renderError: options.renderError,
                  openBrowser: options.openBrowser,
              }),
          )
        : runOAuthFlow<TAccount>({
              provider: options.provider,
              store: options.store,
              displayName: options.displayName,
              scopes,
              readOnly,
              flags,
              preferredPort: port,
              portFallbackCount: options.callbackPort.fallbackCount,
              renderSuccess: options.renderSuccess,
              renderError: options.renderError,
              openBrowser: options.openBrowser,
          })

    const result = await runner
    emitLogin(view, options.displayName, result.account)
}

function stripReservedFlags(cmd: LoginCmdOptions): Record<string, unknown> {
    const { readOnly, token, callbackPort, user, json, ndjson, ...rest } = cmd
    void readOnly
    void token
    void callbackPort
    void user
    void json
    void ndjson
    return rest
}

function emitLogin(view: ViewOptions, displayName: string, account: AuthAccount): void {
    if (view.json) {
        console.log(formatJson({ displayName, account }))
        return
    }
    if (view.ndjson) {
        console.log(formatNdjson([{ displayName, account }]))
        return
    }
    const label = account.label ?? account.id
    console.log(`${chalk.green('✓')} Signed in to ${displayName} as ${chalk.cyan(label)}`)
}
