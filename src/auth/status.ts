import type { Command } from 'commander'
import { CliError } from '../errors.js'
import { formatJson, formatNdjson } from '../json.js'
import type { ViewOptions } from '../options.js'
import type { AuthAccount, TokenStore } from './types.js'

export type AttachStatusContext<TAccount extends AuthAccount> = {
    account: TAccount
    view: Required<ViewOptions>
}

export type AttachStatusCommandOptions<TAccount extends AuthAccount = AuthAccount> = {
    store: TokenStore<TAccount>
    description?: string
    /**
     * Optional live probe. Receives the stored account + token and returns the
     * canonical account to render — typically a fresh API call that confirms
     * the token still works. Throws (e.g. a `CliError('NO_TOKEN', …)` translation
     * of a 401) propagate to the top-level handler.
     */
    fetchLive?(ctx: {
        account: TAccount
        token: string
        view: Required<ViewOptions>
    }): Promise<TAccount>
    /**
     * Human-mode renderer. May return a single string or an array of lines;
     * lines are joined with `\n` on output.
     */
    renderText(ctx: AttachStatusContext<TAccount>): string | readonly string[]
    /**
     * Machine-mode payload. Returned value is serialized as-is via
     * `formatJson` / `formatNdjson`. Defaults to the account object.
     */
    renderJson?(ctx: { account: TAccount }): unknown
    /**
     * Called when `store.active()` returns null. Default behaviour throws
     * `CliError('NOT_AUTHENTICATED', …)`.
     */
    onNotAuthenticated?(view: Required<ViewOptions>): void
}

/**
 * Attach `status` as a subcommand of `parent`. Reads `store.active()`, optionally
 * confirms via `fetchLive`, then dispatches to `renderText` (human) or
 * `renderJson` (machine). Returns the new `Command` so the consumer can chain.
 */
export function attachStatusCommand<TAccount extends AuthAccount = AuthAccount>(
    parent: Command,
    options: AttachStatusCommandOptions<TAccount>,
): Command {
    return parent
        .command('status')
        .description(options.description ?? 'Show the current authentication status')
        .option('--json', 'Emit machine-readable JSON output')
        .option('--ndjson', 'Emit machine-readable NDJSON output')
        .action(async (cmd: Record<string, unknown>) => {
            const view: Required<ViewOptions> = {
                json: Boolean(cmd.json),
                ndjson: Boolean(cmd.ndjson),
            }
            const snapshot = await options.store.active()
            if (!snapshot) {
                if (options.onNotAuthenticated) {
                    options.onNotAuthenticated(view)
                    return
                }
                throw new CliError(
                    'NOT_AUTHENTICATED',
                    'Not authenticated. Run `auth login` to sign in.',
                )
            }
            const account = options.fetchLive
                ? await options.fetchLive({
                      account: snapshot.account,
                      token: snapshot.token,
                      view,
                  })
                : snapshot.account
            const payload = options.renderJson ? options.renderJson({ account }) : account
            if (view.json) {
                console.log(formatJson(payload))
                return
            }
            if (view.ndjson) {
                console.log(formatNdjson([payload]))
                return
            }
            const text = options.renderText({ account, view })
            const lines = typeof text === 'string' ? [text] : text
            for (const line of lines) console.log(line)
        })
}
