import type { Command } from 'commander'
import { CliError } from '../errors.js'
import { formatJson, formatNdjson } from '../json.js'
import type { ViewOptions } from '../options.js'
import type { AuthAccount, TokenStore } from './types.js'

export type AttachStatusContext<TAccount extends AuthAccount> = {
    account: TAccount
    view: Required<ViewOptions>
    /**
     * Stripped per-CLI flags — the parsed options object with the standard
     * registrar flags (`--json`, `--ndjson`, `--user`) removed. Any
     * consumer-attached `.option(...)` lands here (e.g. `--full`).
     */
    flags: Record<string, unknown>
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
        flags: Record<string, unknown>
    }): Promise<TAccount>
    /**
     * Human-mode renderer. May return a single string or an array of lines;
     * lines are joined with `\n` on output.
     */
    renderText(ctx: AttachStatusContext<TAccount>): string | readonly string[]
    /**
     * Machine-mode payload. Returned value is serialized as-is via
     * `formatJson` / `formatNdjson`. Defaults to the account object. Only
     * invoked under `--json` / `--ndjson`.
     */
    renderJson?(ctx: { account: TAccount; flags: Record<string, unknown> }): unknown
    /**
     * Called when `store.active()` returns null. Default behaviour throws
     * `CliError('NOT_AUTHENTICATED', …)`.
     */
    onNotAuthenticated?(ctx: {
        view: Required<ViewOptions>
        flags: Record<string, unknown>
    }): void | Promise<void>
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
        .option('--user <ref>', 'Target a specific stored account by id or label')
        .action(async (cmd: Record<string, unknown>) => {
            const { json, ndjson, user, ...flags } = cmd
            const view: Required<ViewOptions> = {
                json: Boolean(json),
                ndjson: Boolean(ndjson),
            }
            const ref = typeof user === 'string' ? user : undefined
            const snapshot = await options.store.active(ref)
            if (!snapshot) {
                if (options.onNotAuthenticated) {
                    await options.onNotAuthenticated({ view, flags })
                    return
                }
                throw new CliError('NOT_AUTHENTICATED', 'Not signed in.')
            }
            const account = options.fetchLive
                ? await options.fetchLive({
                      account: snapshot.account,
                      token: snapshot.token,
                      view,
                      flags,
                  })
                : snapshot.account
            if (view.json) {
                const payload = options.renderJson
                    ? options.renderJson({ account, flags })
                    : account
                console.log(formatJson(payload))
                return
            }
            if (view.ndjson) {
                const payload = options.renderJson
                    ? options.renderJson({ account, flags })
                    : account
                console.log(formatNdjson([payload]))
                return
            }
            const text = options.renderText({ account, view, flags })
            const lines = typeof text === 'string' ? [text] : text
            for (const line of lines) console.log(line)
        })
}
