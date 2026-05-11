import type { Command } from 'commander'
import { formatJson } from '../json.js'
import type { ViewOptions } from '../options.js'
import type { AuthAccount, TokenStore } from './types.js'

export type AttachLogoutContext<TAccount extends AuthAccount> = {
    /** The account that was active immediately before `clear()` ran, or `null` if nothing was stored. */
    account: TAccount | null
    view: Required<ViewOptions>
    /**
     * Stripped per-CLI flags — the parsed options object with the standard
     * registrar flags (`--json`, `--ndjson`) removed. Any consumer-attached
     * `.option(...)` lands here (e.g. `--user <ref>` from a multi-user CLI).
     */
    flags: Record<string, unknown>
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
            const { json, ndjson, ...flags } = cmd
            const view: Required<ViewOptions> = {
                json: Boolean(json),
                ndjson: Boolean(ndjson),
            }
            // Skip the keyring/file read when no callback consumes the snapshot.
            const snapshot = options.onCleared ? await options.store.active() : null
            const account = snapshot?.account ?? null
            await options.store.clear()
            if (view.json) {
                console.log(formatJson({ ok: true }))
            } else if (!view.ndjson) {
                console.log('✓ Logged out')
            }
            await options.onCleared?.({ account, view, flags })
        })
}
