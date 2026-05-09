import chalk from 'chalk'
import type { ViewOptions } from '../../options.js'
import { runOAuthFlow } from '../flow.js'
import type {
    AuthAccount,
    AuthProvider,
    ErrorContext,
    SuccessContext,
    TokenStore,
} from '../types.js'
import { emitView } from './shared.js'

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
    callbackPort?: number
    json?: boolean
    ndjson?: boolean
    [key: string]: unknown
}

/**
 * Run the `<cli> [auth] login` action — always the OAuth flow. Manual token
 * entry lives behind `<cli> [auth] token set` (stdin-piped) so secrets never
 * cross argv.
 */
export async function runLogin<TAccount extends AuthAccount>(
    options: LoginHandlerOptions<TAccount>,
    cmd: LoginCmdOptions,
): Promise<void> {
    const view: ViewOptions = { json: cmd.json, ndjson: cmd.ndjson }
    const readOnly = Boolean(cmd.readOnly)
    const flags = stripReservedFlags(cmd)

    const scopes = options.resolveScopes({ readOnly, flags })
    const port = cmd.callbackPort ?? options.callbackPort.preferred

    const runFlow = () =>
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
        })

    const result = options.withSpinner
        ? await options.withSpinner(
              { text: 'Waiting for authorization...', color: 'blue' },
              runFlow,
          )
        : await runFlow()

    const account = result.account
    const label = account.label ?? account.id
    emitView(view, { displayName: options.displayName, account }, () => [
        `${chalk.green('✓')} Signed in to ${options.displayName} as ${chalk.cyan(label)}`,
    ])
}

function stripReservedFlags(cmd: LoginCmdOptions): Record<string, unknown> {
    const { readOnly, callbackPort, json, ndjson, ...rest } = cmd
    void readOnly
    void callbackPort
    void json
    void ndjson
    return rest
}
