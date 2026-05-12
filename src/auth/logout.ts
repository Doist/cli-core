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

export type AttachLogoutRevokeContext<TAccount extends AuthAccount> = {
    /** Live token from the snapshot — pass to the server-side revocation endpoint. */
    token: string
    /** The account the token belongs to. Non-null because the hook is skipped when nothing is stored. */
    account: TAccount
    view: Required<ViewOptions>
    /** Same shape as `AttachLogoutContext.flags`. */
    flags: Record<string, unknown>
}

export type AttachLogoutCommandOptions<TAccount extends AuthAccount = AuthAccount> = {
    store: TokenStore<TAccount>
    /** Override the subcommand description. */
    description?: string
    /**
     * Fires before `store.clear()` runs, when a prior session is stored. Use
     * to call a server-side token-revocation endpoint. Errors are swallowed
     * so local logout always succeeds even when the server is unreachable;
     * surface diagnostics via your own logging if needed. Skipped entirely
     * when `store.active()` returns `null`.
     */
    revokeToken?(ctx: AttachLogoutRevokeContext<TAccount>): Promise<void>
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
            const needsSnapshot = Boolean(options.revokeToken || options.onCleared)
            const snapshot = needsSnapshot ? await options.store.active() : null
            const account = snapshot?.account ?? null
            if (options.revokeToken && snapshot) {
                try {
                    await options.revokeToken({
                        token: snapshot.token,
                        account: snapshot.account,
                        view,
                        flags,
                    })
                } catch {
                    // Best-effort: server revoke failures must not block local clear.
                }
            }
            await options.store.clear()
            if (view.json) {
                console.log(formatJson({ ok: true }))
            } else if (!view.ndjson) {
                console.log('✓ Logged out')
            }
            await options.onCleared?.({ account, view, flags })
        })
}
