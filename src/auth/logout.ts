import type { Command } from 'commander'
import { formatJson } from '../json.js'
import type { ViewOptions } from '../options.js'
import type { AuthAccount, TokenStore } from './types.js'
import { attachUserFlag, extractUserRef, requireSnapshotForRef } from './user-flag.js'

export type AttachLogoutContext<TAccount extends AuthAccount> = {
    /** The account that was active immediately before `clear()` ran, or `null` if nothing was stored. */
    account: TAccount | null
    /** `--json` / `--ndjson` flag values, both present (defaulted to `false`). */
    view: Required<ViewOptions>
    /** Consumer-attached options. The registrar flags (`--json`, `--ndjson`, `--user`) are stripped. */
    flags: Record<string, unknown>
}

export type AttachLogoutRevokeContext<TAccount extends AuthAccount> = Omit<
    AttachLogoutContext<TAccount>,
    'account'
> & {
    /** Live token from the snapshot — pass to the server-side revocation endpoint. */
    token: string
    /** Non-null because the hook is skipped when nothing was stored. */
    account: TAccount
}

export type AttachLogoutCommandOptions<TAccount extends AuthAccount = AuthAccount> = {
    store: TokenStore<TAccount>
    /** Override the subcommand description. */
    description?: string
    /**
     * Fires after `store.clear()` resolves, when a prior session was stored.
     * Use to call a server-side token-revocation endpoint. The hook is awaited,
     * but errors are swallowed so local logout always succeeds even when the
     * server is unreachable. Skipped when no session was stored or when
     * `store.active()` itself fails.
     */
    revokeToken?(ctx: AttachLogoutRevokeContext<TAccount>): void | Promise<void>
    /**
     * Fires after `revokeToken` settles. Use to surface keyring-fallback
     * warnings or other CLI-specific follow-ups. Consumers in machine-output
     * mode should route any extra prose to stderr to keep stdout parseable.
     */
    onCleared?(ctx: AttachLogoutContext<TAccount>): void | Promise<void>
}

/**
 * Attach `logout` as a subcommand of `parent`. Snapshots the active session
 * (only when a hook needs it), calls `store.clear()`, optionally awaits
 * `revokeToken` for best-effort server-side revocation, emits the success
 * line gated on `--json` / `--ndjson`, then invokes `onCleared` for
 * follow-ups. Returns the new `Command` so the consumer can chain.
 */
export function attachLogoutCommand<TAccount extends AuthAccount = AuthAccount>(
    parent: Command,
    options: AttachLogoutCommandOptions<TAccount>,
): Command {
    const command = parent
        .command('logout')
        .description(options.description ?? 'Remove the saved authentication token')
        .option('--json', 'Emit machine-readable JSON output')
        .option('--ndjson', 'Emit machine-readable NDJSON output')
    return attachUserFlag(command).action(async (cmd: Record<string, unknown>) => {
        const { json, ndjson, user: _user, ...flags } = cmd
        const view: Required<ViewOptions> = {
            json: Boolean(json),
            ndjson: Boolean(ndjson),
        }
        const ref = extractUserRef(cmd)
        // Explicit ref must surface a typed miss before `clear()` runs —
        // `clear(ref)` is contractually a no-op on miss, so otherwise
        // `logout --user mistake` would print `✓ Logged out`.
        const needsSnapshot = ref !== undefined || Boolean(options.revokeToken || options.onCleared)
        let snapshot: { token: string; account: TAccount } | null = null
        if (needsSnapshot) {
            if (ref !== undefined) {
                snapshot = await requireSnapshotForRef(options.store, ref)
            } else {
                try {
                    snapshot = await options.store.active(ref)
                } catch {
                    // Snapshot lookup failures must not block local clear.
                }
            }
        }
        const account = snapshot?.account ?? null
        await options.store.clear(ref)
        if (options.revokeToken && snapshot) {
            try {
                await options.revokeToken({
                    token: snapshot.token,
                    account: snapshot.account,
                    view,
                    flags,
                })
            } catch {
                // Best-effort: server revoke failures must not surface to the user.
            }
        }
        if (view.json) {
            console.log(formatJson({ ok: true }))
        } else if (!view.ndjson) {
            console.log('✓ Logged out')
        }
        await options.onCleared?.({ account, view, flags })
    })
}
