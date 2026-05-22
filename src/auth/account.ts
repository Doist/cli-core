import type { Command } from 'commander'
import { formatJson, formatNdjson } from '../json.js'
import type { ViewOptions } from '../options.js'
import type { AccountRef, AuthAccount, TokenStore } from './types.js'

export type AttachAccountListContext<TAccount extends AuthAccount> = {
    /** Every stored account with its default marker, in store order. */
    accounts: ReadonlyArray<{ account: TAccount; isDefault: boolean }>
    /** The default account's ref (its `id`), or `null` when nothing is stored. */
    default: AccountRef | null
    /** `--json` / `--ndjson` flag values, both present (defaulted to `false`). */
    view: Required<ViewOptions>
    /** Consumer-attached options. The registrar flags (`--json`, `--ndjson`) are stripped. */
    flags: Record<string, unknown>
}

export type AttachAccountListCommandOptions<TAccount extends AuthAccount = AuthAccount> = {
    store: TokenStore<TAccount>
    description?: string
    /**
     * Human-mode renderer over the full list. May return a single string or an
     * array of lines; lines are joined with `\n` on output. Defaults to one
     * line per account (`<label ?? id> (id:<id>)`, plus ` (default)` on the
     * default entry) and an empty-state message when nothing is stored.
     */
    renderText?(ctx: AttachAccountListContext<TAccount>): string | readonly string[]
    /**
     * Per-account machine payload, invoked once per entry. The returned value
     * becomes one element of the `--json` `accounts` array and one `--ndjson`
     * line, so the per-account shape stays identical across both modes.
     * Defaults to `{ account, isDefault }`. Only invoked under `--json` / `--ndjson`.
     */
    renderJson?(ctx: {
        account: TAccount
        isDefault: boolean
        flags: Record<string, unknown>
    }): unknown
}

export type AttachAccountUseCommandOptions<TAccount extends AuthAccount = AuthAccount> = {
    store: TokenStore<TAccount>
    description?: string
    /**
     * Fires after `store.setDefault` resolves. `ref` is the raw user-supplied
     * positional argument. Use for CLI-specific follow-ups (e.g. dropping a
     * cached client bound to the previous default). Awaited.
     */
    onDefaultSet?(ctx: {
        ref: AccountRef
        view: Required<ViewOptions>
        flags: Record<string, unknown>
    }): void | Promise<void>
}

function defaultListText<TAccount extends AuthAccount>(
    ctx: AttachAccountListContext<TAccount>,
): string[] {
    if (ctx.accounts.length === 0) return ['No accounts stored.']
    return ctx.accounts.map(({ account, isDefault }) => {
        const name = account.label ?? account.id
        return `${name} (id:${account.id})${isDefault ? ' (default)' : ''}`
    })
}

/**
 * Attach `list` as a subcommand of `parent` (typically an `account` group).
 * Reads `store.list()` and renders every stored account with its default
 * marker. `--json` emits a `{ accounts, default }` envelope where `default` is
 * the default entry's `account.id` (or `null`); `--ndjson` streams one
 * per-account object per line (no envelope, no `default` field — that is
 * envelope-level metadata available only via `--json`). Returns the new
 * `Command` so the consumer can chain.
 *
 * Note: `default` is derived from `account.id` (the contract's stable index
 * key). A store whose ref-matching rule is not id-based should override the
 * surfaced ref via `renderJson` if it needs a different value echoed.
 */
export function attachAccountListCommand<TAccount extends AuthAccount = AuthAccount>(
    parent: Command,
    options: AttachAccountListCommandOptions<TAccount>,
): Command {
    return parent
        .command('list')
        .description(options.description ?? 'List stored accounts')
        .option('--json', 'Emit machine-readable JSON output')
        .option('--ndjson', 'Emit machine-readable NDJSON output')
        .action(async (cmd: Record<string, unknown>) => {
            const { json, ndjson, ...flags } = cmd
            const view: Required<ViewOptions> = {
                json: Boolean(json),
                ndjson: Boolean(ndjson),
            }
            const accounts = await options.store.list()
            const defaultRef: AccountRef | null =
                accounts.find((entry) => entry.isDefault)?.account.id ?? null
            if (view.json || view.ndjson) {
                const payloads = accounts.map(({ account, isDefault }) =>
                    options.renderJson
                        ? options.renderJson({ account, isDefault, flags })
                        : { account, isDefault },
                )
                if (view.json) {
                    console.log(formatJson({ accounts: payloads, default: defaultRef }))
                } else if (payloads.length > 0) {
                    console.log(formatNdjson(payloads))
                }
                return
            }
            const text = options.renderText
                ? options.renderText({ accounts, default: defaultRef, view, flags })
                : defaultListText({ accounts, default: defaultRef, view, flags })
            const lines = typeof text === 'string' ? [text] : text
            for (const line of lines) console.log(line)
        })
}

/**
 * Attach `use <ref>` as a subcommand of `parent` (typically an `account`
 * group). Calls `store.setDefault(ref)` and emits the success envelope
 * (`✓ Default account set to <ref>` in plain, `{ ok: true, default: <ref> }`
 * under `--json`, silent under `--ndjson`). `setDefault`'s
 * `CliError('ACCOUNT_NOT_FOUND', …)` on a ref miss propagates unchanged.
 * Returns the new `Command` so the consumer can chain.
 */
export function attachAccountUseCommand<TAccount extends AuthAccount = AuthAccount>(
    parent: Command,
    options: AttachAccountUseCommandOptions<TAccount>,
): Command {
    return parent
        .command('use')
        .description(options.description ?? 'Set the default account')
        .argument('<ref>', 'Account reference to set as default')
        .option('--json', 'Emit machine-readable JSON output')
        .option('--ndjson', 'Emit machine-readable NDJSON output')
        .action(async (ref: string, cmd: Record<string, unknown>) => {
            const { json, ndjson, ...flags } = cmd
            const view: Required<ViewOptions> = {
                json: Boolean(json),
                ndjson: Boolean(ndjson),
            }
            await options.store.setDefault(ref)
            if (view.json) {
                console.log(formatJson({ ok: true, default: ref }))
            } else if (!view.ndjson) {
                console.log(`✓ Default account set to ${ref}`)
            }
            await options.onDefaultSet?.({ ref, view, flags })
        })
}
