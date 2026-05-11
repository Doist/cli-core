import type { Command } from 'commander'
import { formatJson } from '../json.js'
import type { ViewOptions } from '../options.js'
import type { AuthAccount, TokenStore } from './types.js'

export type AttachLogoutContext<TAccount extends AuthAccount> = {
    /** The account that was active immediately before `clear()` ran, or `null` if nothing was stored. */
    account: TAccount | null
    view: Required<ViewOptions>
}

export type AttachLogoutCommandOptions<TAccount extends AuthAccount = AuthAccount> = {
    store: TokenStore<TAccount>
    /** Override the subcommand description. */
    description?: string
    /**
     * Fires after `store.clear()` resolves. Use to surface keyring-fallback
     * warnings or other CLI-specific follow-ups. Consumers in machine-output
     * mode should route any extra prose to stderr to keep stdout parseable.
     */
    onCleared?(ctx: AttachLogoutContext<TAccount>): void | Promise<void>
}

/**
 * Attach `logout` as a subcommand of `parent`. Snapshots the active account,
 * calls `store.clear()`, emits a sensible default success line gated on
 * `--json` / `--ndjson`, then invokes `onCleared` for follow-ups. Returns the
 * new `Command` so the consumer can chain.
 */
export function attachLogoutCommand<TAccount extends AuthAccount = AuthAccount>(
    parent: Command,
    options: AttachLogoutCommandOptions<TAccount>,
): Command {
    return parent
        .command('logout')
        .description(options.description ?? 'Remove the saved authentication token')
        .option('--json', 'Emit machine-readable JSON output')
        .option('--ndjson', 'Emit machine-readable NDJSON output')
        .action(async (cmd: Record<string, unknown>) => {
            const view: Required<ViewOptions> = {
                json: Boolean(cmd.json),
                ndjson: Boolean(cmd.ndjson),
            }
            const snapshot = await options.store.active()
            const account = snapshot?.account ?? null
            await options.store.clear()
            if (view.json) {
                console.log(formatJson({ ok: true }))
            } else if (!view.ndjson) {
                console.log('✓ Logged out')
            }
            await options.onCleared?.({ account, view })
        })
}
