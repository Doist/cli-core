import type { Command } from 'commander'
import { CliError } from '../errors.js'
import { formatJson, formatNdjson } from '../json.js'
import { type ViewOptions, emitView } from '../options.js'
import type { AccountRef, AuthAccount, TokenStore } from './types.js'
import { accountNotFoundError } from './user-flag.js'

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
     * A non-serializable return throws `CliError('INVALID_TYPE', …)` in both
     * machine modes (rather than silently nulling under `--json`).
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

/** Split the parsed Commander options into the canonical machine-output view + the remaining consumer flags. */
function splitViewFlags(cmd: Record<string, unknown>): {
    view: Required<ViewOptions>
    flags: Record<string, unknown>
} {
    const { json, ndjson, ...flags } = cmd
    return { view: { json: Boolean(json), ndjson: Boolean(ndjson) }, flags }
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
 * envelope-level metadata available only via `--json`). When both flags are
 * present `--json` wins, matching `emitView` / `status` / `logout`. Returns the
 * new `Command` so the consumer can chain.
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
            const { view, flags } = splitViewFlags(cmd)
            const accounts = await options.store.list()
            const defaultRef: AccountRef | null =
                accounts.find((entry) => entry.isDefault)?.account.id ?? null
            // Build + validate one per-account payload. Validating before either
            // serializer means a non-serializable `renderJson` result fails the
            // same way under `--json` and `--ndjson` (a raw `undefined` element
            // would otherwise serialize to `null` in the JSON array but throw
            // in NDJSON).
            const toPayload = (entry: { account: TAccount; isDefault: boolean }) => {
                const payload = options.renderJson
                    ? options.renderJson({
                          account: entry.account,
                          isDefault: entry.isDefault,
                          flags,
                      })
                    : { account: entry.account, isDefault: entry.isDefault }
                if (JSON.stringify(payload) === undefined) {
                    throw new CliError(
                        'INVALID_TYPE',
                        `renderJson returned a non-serializable value for account "${entry.account.id}".`,
                    )
                }
                return payload
            }
            // NDJSON streams one object per account; emit each line as it's
            // produced rather than buffering a joined string. `--json` wins when
            // both flags are set. Empty list → no lines (EOF-as-end-of-stream).
            if (view.ndjson && !view.json) {
                for (const entry of accounts) console.log(formatNdjson([toPayload(entry)]))
                return
            }
            // `renderJson` is machine-mode only, so build the payload lazily —
            // emitView ignores it in human mode where the thunk runs instead.
            const payload = view.json
                ? { accounts: accounts.map(toPayload), default: defaultRef }
                : {}
            emitView(view, payload, () => {
                const ctx: AttachAccountListContext<TAccount> = {
                    accounts,
                    default: defaultRef,
                    view,
                    flags,
                }
                const text = options.renderText ? options.renderText(ctx) : defaultListText(ctx)
                return typeof text === 'string' ? [text] : text
            })
        })
}

/**
 * Attach `use <ref>` as a subcommand of `parent` (typically an `account`
 * group). Calls `store.setDefault(ref)`; under `--json` it then re-reads
 * `store.list()` to resolve the now-default account's canonical `id` so the
 * `default` field matches what `account list --json` reports for the same
 * account (round-trippable). Human mode echoes the raw `<ref>` typed and skips
 * the re-read, so a follow-up store error can't fail a command whose write
 * already succeeded. `--ndjson` is silent (success-action convention, matching
 * `logout`); `--json` wins when both flags are present. `setDefault`'s
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
            const { view, flags } = splitViewFlags(cmd)
            await options.store.setDefault(ref)
            // Skip the silent pure-`--ndjson` case; `--json` wins over it.
            if (view.json || !view.ndjson) {
                const resolvedDefault: AccountRef = view.json
                    ? ((await options.store.list()).find((entry) => entry.isDefault)?.account.id ??
                      ref)
                    : ref
                emitView(view, { ok: true, default: resolvedDefault }, () => [
                    `✓ Default account set to ${ref}`,
                ])
            }
            await options.onDefaultSet?.({ ref, view, flags })
        })
}

export type AttachAccountCurrentContext<TAccount extends AuthAccount> = {
    /** The resolved active account. */
    account: TAccount
    /** Whether the active account is the store's effective default. */
    isDefault: boolean
    /** `--json` / `--ndjson` flag values, both present (defaulted to `false`). */
    view: Required<ViewOptions>
    /** Consumer-attached options. The registrar flags (`--json`, `--ndjson`) are stripped. */
    flags: Record<string, unknown>
}

export type AttachAccountCurrentCommandOptions<TAccount extends AuthAccount = AuthAccount> = {
    store: TokenStore<TAccount>
    description?: string
    /**
     * Human-mode renderer. May return a single string or an array of lines;
     * lines are joined with `\n` on output. Defaults to `<label ?? id> (id:<id>)`
     * plus ` (default)` on the default account.
     */
    renderText?(ctx: AttachAccountCurrentContext<TAccount>): string | readonly string[]
    /**
     * Machine-mode payload, serialized as-is via `formatJson` / `formatNdjson`
     * (identically across both modes). Defaults to `{ account, isDefault }`.
     * Only invoked under `--json` / `--ndjson`. A non-serializable return
     * throws `CliError('INVALID_TYPE', …)`.
     */
    renderJson?(ctx: {
        account: TAccount
        isDefault: boolean
        flags: Record<string, unknown>
    }): unknown
    /**
     * Called when `store.active()` resolves nothing. Default behaviour throws
     * `CliError('NOT_AUTHENTICATED', …)`. Consumers with out-of-store credential
     * sources (env var, legacy single-user creds) use this hook to render those
     * cases — mirroring `attachStatusCommand`.
     */
    onNotAuthenticated?(ctx: {
        view: Required<ViewOptions>
        flags: Record<string, unknown>
    }): void | Promise<void>
}

/**
 * Attach `current` as a subcommand of `parent` (typically an `account` group).
 * Reads the active credential via `store.active()` (no selector — the active
 * account is whatever the store resolves by default), derives the `(default)`
 * marker from `store.list()` keyed on `account.id` (so it stays identical to
 * `account list`), then dispatches to `renderText` (human) or `renderJson`
 * (machine). `--json` wins when both flags are present. When `store.active()`
 * returns null it invokes `onNotAuthenticated` (or throws `NOT_AUTHENTICATED`).
 * Returns the new `Command` so the consumer can chain.
 */
export function attachAccountCurrentCommand<TAccount extends AuthAccount = AuthAccount>(
    parent: Command,
    options: AttachAccountCurrentCommandOptions<TAccount>,
): Command {
    return parent
        .command('current')
        .description(options.description ?? 'Show the active account')
        .option('--json', 'Emit machine-readable JSON output')
        .option('--ndjson', 'Emit machine-readable NDJSON output')
        .action(async (cmd: Record<string, unknown>) => {
            const { view, flags } = splitViewFlags(cmd)
            const snapshot = await options.store.active()
            if (!snapshot) {
                if (options.onNotAuthenticated) {
                    await options.onNotAuthenticated({ view, flags })
                    return
                }
                throw new CliError('NOT_AUTHENTICATED', 'Not signed in.')
            }
            const accounts = await options.store.list()
            const isDefault = accounts.some(
                (entry) => entry.account.id === snapshot.account.id && entry.isDefault,
            )
            if (view.json || view.ndjson) {
                const payload = options.renderJson
                    ? options.renderJson({ account: snapshot.account, isDefault, flags })
                    : { account: snapshot.account, isDefault }
                if (JSON.stringify(payload) === undefined) {
                    throw new CliError(
                        'INVALID_TYPE',
                        `renderJson returned a non-serializable value for account "${snapshot.account.id}".`,
                    )
                }
                console.log(view.json ? formatJson(payload) : formatNdjson([payload]))
                return
            }
            const ctx: AttachAccountCurrentContext<TAccount> = {
                account: snapshot.account,
                isDefault,
                view,
                flags,
            }
            const text = options.renderText
                ? options.renderText(ctx)
                : `${snapshot.account.label ?? snapshot.account.id} (id:${snapshot.account.id})${
                      isDefault ? ' (default)' : ''
                  }`
            const lines = typeof text === 'string' ? [text] : text
            for (const line of lines) console.log(line)
        })
}

export type AttachAccountRemoveContext<TAccount extends AuthAccount> = {
    /** The account that was removed, resolved before `clear()`. */
    account: TAccount
    /** The raw `<ref>` positional the user typed. */
    ref: AccountRef
    /** Whether the removed account was the default before clearing. */
    wasDefault: boolean
    /** `--json` / `--ndjson` flag values, both present (defaulted to `false`). */
    view: Required<ViewOptions>
    /** Consumer-attached options. The registrar flags (`--json`, `--ndjson`) are stripped. */
    flags: Record<string, unknown>
}

export type AttachAccountRemoveCommandOptions<TAccount extends AuthAccount = AuthAccount> = {
    store: TokenStore<TAccount>
    description?: string
    /**
     * Human-mode renderer over the removed account. Defaults to
     * `✓ Removed <label ?? id>`, plus a `Cleared default account.` line when the
     * removed account was the default. Consumers override to localise the
     * wording (e.g. add a CLI-specific "set a new default" hint). Not called
     * under `--json` / `--ndjson`.
     */
    renderText?(ctx: AttachAccountRemoveContext<TAccount>): string | readonly string[]
    /**
     * Fires after `clear()` resolves and the success line is emitted (in every
     * output mode). Awaited. Use for store-specific follow-ups not on the
     * `TokenStore` contract — e.g. surfacing a keyring-fallback warning to
     * stderr.
     */
    onRemoved?(ctx: AttachAccountRemoveContext<TAccount>): void | Promise<void>
}

/**
 * Attach `remove <ref>` as a subcommand of `parent` (typically an `account`
 * group). Resolves `<ref>` via `store.active(ref)` (throwing
 * `ACCOUNT_NOT_FOUND` on a miss), captures the default marker from
 * `store.list()` before clearing, then calls `store.clear(account.id)` — always
 * the resolved canonical id, never the raw ref, since `clear()` is keyed by id
 * and silently no-ops on an email/label ref. `--json` emits
 * `{ ok: true, removed: <id> }`; `--ndjson` is silent (success-action
 * convention); `--json` wins when both are present. Returns the new `Command`
 * so the consumer can chain.
 */
export function attachAccountRemoveCommand<TAccount extends AuthAccount = AuthAccount>(
    parent: Command,
    options: AttachAccountRemoveCommandOptions<TAccount>,
): Command {
    return parent
        .command('remove')
        .description(options.description ?? 'Remove a stored account')
        .argument(
            '<ref>',
            'Account reference to remove (id, or a store-defined alias such as email)',
        )
        .option('--json', 'Emit machine-readable JSON output')
        .option('--ndjson', 'Emit machine-readable NDJSON output')
        .action(async (ref: string, cmd: Record<string, unknown>) => {
            const { view, flags } = splitViewFlags(cmd)
            const snapshot = await options.store.active(ref)
            if (!snapshot) throw accountNotFoundError(ref)
            const accounts = await options.store.list()
            const wasDefault = accounts.some(
                (entry) => entry.account.id === snapshot.account.id && entry.isDefault,
            )
            await options.store.clear(snapshot.account.id)
            const ctx: AttachAccountRemoveContext<TAccount> = {
                account: snapshot.account,
                ref,
                wasDefault,
                view,
                flags,
            }
            if (view.json) {
                console.log(formatJson({ ok: true, removed: snapshot.account.id }))
            } else if (!view.ndjson) {
                const removedLine = `✓ Removed ${snapshot.account.label ?? snapshot.account.id}`
                const text = options.renderText
                    ? options.renderText(ctx)
                    : wasDefault
                      ? [removedLine, 'Cleared default account.']
                      : removedLine
                const lines = typeof text === 'string' ? [text] : text
                for (const line of lines) console.log(line)
            }
            await options.onRemoved?.(ctx)
        })
}
