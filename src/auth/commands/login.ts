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
    json?: boolean
    ndjson?: boolean
    [key: string]: unknown
}

export type RunLoginExtras = {
    /**
     * Extra Commander-derived attribute names to strip from `cmd` before the
     * remainder is forwarded to the provider via `flags`. The registrar uses
     * this to drop the callback-port flag (whose attribute name varies with
     * the caller's `flagSpec`).
     */
    reservedFlagAttrs?: ReadonlyArray<string>
}

const ALWAYS_RESERVED = new Set(['readOnly', 'json', 'ndjson'])

/**
 * Run the `<cli> [auth] login` action — always the OAuth flow.
 */
export async function runLogin<TAccount extends AuthAccount>(
    options: LoginHandlerOptions<TAccount>,
    cmd: LoginCmdOptions,
    extras: RunLoginExtras = {},
): Promise<void> {
    const view: ViewOptions = { json: cmd.json, ndjson: cmd.ndjson }
    const readOnly = Boolean(cmd.readOnly)
    const flags = stripReservedFlags(cmd, extras.reservedFlagAttrs ?? [])

    const scopes = options.resolveScopes({ readOnly, flags })

    const runFlow = () =>
        runOAuthFlow<TAccount>({
            provider: options.provider,
            store: options.store,
            displayName: options.displayName,
            scopes,
            readOnly,
            flags,
            preferredPort: options.callbackPort.preferred,
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

function stripReservedFlags(
    cmd: LoginCmdOptions,
    extraReserved: ReadonlyArray<string>,
): Record<string, unknown> {
    const reserved = new Set([...ALWAYS_RESERVED, ...extraReserved])
    const result: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(cmd)) {
        if (!reserved.has(key)) result[key] = value
    }
    return result
}
