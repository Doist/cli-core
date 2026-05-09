import type { Command } from 'commander'
import { CliError } from '../errors.js'
import { runOAuthFlow } from './flow.js'
import type { AuthAccount, AuthProvider, TokenStore } from './types.js'

export type AttachLoginView = {
    json: boolean
    ndjson: boolean
}

export type AttachLoginCommandOptions<TAccount extends AuthAccount = AuthAccount> = {
    provider: AuthProvider<TAccount>
    store: TokenStore<TAccount>
    /** Default local OAuth callback port. Overridable per-invocation via `--callback-port`. */
    preferredPort: number
    /** Walk up this many sequential ports if `preferredPort` is busy. Default: 5. */
    portFallbackCount?: number
    /** Resolve the scope list to request from the runtime flags + read-only state. */
    resolveScopes(ctx: { readOnly: boolean; flags: Record<string, unknown> }): string[]
    renderSuccess(): string
    renderError(message: string): string
    /** Override the browser opener (tests). When omitted, `runOAuthFlow` imports `open`. */
    openBrowser?(url: string): Promise<void>
    /**
     * Called after the token is persisted. Receives the resolved account and
     * the `--json` / `--ndjson` view flags so the consumer can format output.
     */
    onSuccess(account: TAccount, view: AttachLoginView): void | Promise<void>
}

/**
 * Attach `login` as a subcommand of `parent`. Wires the standard flag set
 * (`--read-only`, `--callback-port`, `--json`, `--ndjson`) and drives
 * `runOAuthFlow`. Returns the new `Command` so the consumer can chain
 * `.description(...)` / `.option(...)` / `.addHelpText(...)` for additional
 * flags or help text.
 *
 * Additional Commander options the consumer attaches to the returned command
 * land on the same parsed options object Commander hands to the action, so
 * `resolveScopes` and `onSuccess` see them via `flags`.
 */
export function attachLoginCommand<TAccount extends AuthAccount>(
    parent: Command,
    options: AttachLoginCommandOptions<TAccount>,
): Command {
    return parent
        .command('login')
        .option('--read-only', 'Request read-only scopes')
        .option('--callback-port <port>', 'Override the local OAuth callback port', parsePort)
        .option('--json', 'Emit machine-readable JSON output')
        .option('--ndjson', 'Emit machine-readable NDJSON output')
        .action(async (cmd: Record<string, unknown>) => {
            const { readOnly, callbackPort, json, ndjson, ...flags } = cmd
            const view: AttachLoginView = { json: Boolean(json), ndjson: Boolean(ndjson) }
            const machineOutput = view.json || view.ndjson
            const result = await runOAuthFlow<TAccount>({
                provider: options.provider,
                store: options.store,
                scopes: options.resolveScopes({ readOnly: Boolean(readOnly), flags }),
                readOnly: Boolean(readOnly),
                flags,
                preferredPort: (callbackPort as number | undefined) ?? options.preferredPort,
                portFallbackCount: options.portFallbackCount,
                renderSuccess: options.renderSuccess,
                renderError: options.renderError,
                openBrowser: options.openBrowser,
                // Suppress the human-mode authorize-URL fallback print under
                // machine output so JSON / NDJSON consumers never see a stray
                // line on stdout.
                onAuthorizeUrl: machineOutput ? () => undefined : undefined,
            })
            await options.onSuccess(result.account, view)
        })
}

function parsePort(raw: string): number {
    if (!/^\d+$/.test(raw)) {
        throw new CliError(
            'AUTH_PORT_BIND_FAILED',
            `Invalid --callback-port '${raw}': expected an integer in [0..65535].`,
        )
    }
    const port = Number(raw)
    if (port > 65535) {
        throw new CliError(
            'AUTH_PORT_BIND_FAILED',
            `Invalid --callback-port '${raw}': expected an integer in [0..65535].`,
        )
    }
    return port
}
