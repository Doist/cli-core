import type { Command } from 'commander'
import { CliError } from '../errors.js'
import type { ViewOptions } from '../options.js'
import { runOAuthFlow } from './flow.js'
import type { AuthAccount, AuthProvider, TokenStore } from './types.js'

export type AttachLoginContext<TAccount extends AuthAccount> = {
    account: TAccount
    /** `--json` / `--ndjson` flag values, both present (defaulted to `false`). */
    view: Required<ViewOptions>
    /**
     * Stripped per-CLI flags — the parsed options object with the standard
     * registrar flags (`--read-only`, `--callback-port`, `--json`, `--ndjson`)
     * removed. Same view `resolveScopes` saw at flow start.
     */
    flags: Record<string, unknown>
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
     * Override the authorize-URL fallback callback that fires when the browser
     * can't be opened (no `open` peer / opener throws). When omitted, the URL
     * is written to stderr in machine-output mode (so the JSON / NDJSON
     * envelope on stdout stays clean) and to stdout via `runOAuthFlow`'s
     * default in human mode.
     */
    onAuthorizeUrl?(url: string): void
    /** Called after the token is persisted. */
    onSuccess(ctx: AttachLoginContext<TAccount>): void | Promise<void>
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
            const view: Required<ViewOptions> = {
                json: Boolean(json),
                ndjson: Boolean(ndjson),
            }
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
                // In machine-output mode, route the fallback URL to stderr so
                // the JSON / NDJSON envelope on stdout stays clean — the user
                // can still see the URL if `open` is missing or throws. In
                // human mode, leave it undefined so `runOAuthFlow`'s TTY
                // default (stdout) fires. Consumer override wins either way.
                onAuthorizeUrl:
                    options.onAuthorizeUrl ??
                    (machineOutput
                        ? (url: string) => {
                              process.stderr.write(`Open this URL in your browser:\n  ${url}\n`)
                          }
                        : undefined),
            })
            await options.onSuccess({ account: result.account, view, flags })
        })
}

function parsePort(raw: string): number {
    const port = /^\d+$/.test(raw) ? Number(raw) : Number.NaN
    if (!Number.isFinite(port) || port > 65535) {
        throw new CliError(
            'AUTH_PORT_BIND_FAILED',
            `Invalid --callback-port '${raw}': expected an integer in [0..65535].`,
        )
    }
    return port
}
