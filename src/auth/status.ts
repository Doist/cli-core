import type { Command } from 'commander'
import { CliError } from '../errors.js'
import { formatJson, formatNdjson } from '../json.js'
import type { ViewOptions } from '../options.js'
import type { AccountRef, AuthAccount, TokenBundle, TokenStore } from './types.js'
import { attachUserFlag, extractUserRef, requireSnapshotForRef } from './user-flag.js'

/**
 * Opportunistic bundle read for `fetchLive`. Stores that don't implement
 * `activeBundle` get `undefined`; any error during the bundle read is
 * swallowed so a refresh-slot fault can't break the status command, which
 * is the user's first port of call when something is wrong.
 */
async function readBundleBestEffort<TAccount extends AuthAccount>(
    store: TokenStore<TAccount>,
    ref: AccountRef | undefined,
): Promise<TokenBundle | undefined> {
    if (!store.activeBundle) return undefined
    try {
        const snapshot = await store.activeBundle(ref)
        return snapshot?.bundle
    } catch {
        return undefined
    }
}

export type AttachStatusContext<TAccount extends AuthAccount> = {
    account: TAccount
    /** `--json` / `--ndjson` flag values, both present (defaulted to `false`). */
    view: Required<ViewOptions>
    /** Consumer-attached options (e.g. `--full`). The registrar flags (`--json`, `--ndjson`, `--user`) are stripped. */
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
        /**
         * Full bundle when the store implements `activeBundle` — lets a
         * consumer render expiry without a second read. Absent when the
         * store only exposes `active()` (no refresh-side metadata available).
         */
        bundle?: TokenBundle
        /** `--json` / `--ndjson` flag values, both present (defaulted to `false`). */
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
        /** `--json` / `--ndjson` flag values, both present (defaulted to `false`). */
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
    const command = parent
        .command('status')
        .description(options.description ?? 'Show the current authentication status')
        .option('--json', 'Emit machine-readable JSON output')
        .option('--ndjson', 'Emit machine-readable NDJSON output')
    return attachUserFlag(command).action(async (cmd: Record<string, unknown>) => {
        const { json, ndjson, user: _user, ...flags } = cmd
        const view: Required<ViewOptions> = {
            json: Boolean(json),
            ndjson: Boolean(ndjson),
        }
        const ref = extractUserRef(cmd)
        const snapshot = await requireSnapshotForRef(options.store, ref)
        if (!snapshot) {
            if (options.onNotAuthenticated) {
                await options.onNotAuthenticated({ view, flags })
                return
            }
            throw new CliError('NOT_AUTHENTICATED', 'Not signed in.')
        }
        const bundle = options.fetchLive
            ? await readBundleBestEffort(options.store, ref)
            : undefined
        const account = options.fetchLive
            ? await options.fetchLive({
                  account: snapshot.account,
                  token: snapshot.token,
                  ...(bundle ? { bundle } : {}),
                  view,
                  flags,
              })
            : snapshot.account
        if (view.json) {
            const payload = options.renderJson ? options.renderJson({ account, flags }) : account
            console.log(formatJson(payload))
            return
        }
        if (view.ndjson) {
            const payload = options.renderJson ? options.renderJson({ account, flags }) : account
            console.log(formatNdjson([payload]))
            return
        }
        const text = options.renderText({ account, view, flags })
        const lines = typeof text === 'string' ? [text] : text
        for (const line of lines) console.log(line)
    })
}
