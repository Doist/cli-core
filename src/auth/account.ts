import type { Command } from 'commander'
import { CliError } from '../errors.js'
import { formatJson, formatNdjson } from '../json.js'
import { type ViewOptions, emitView } from '../options.js'
import type {
    AccountRef,
    AttachContextBase,
    AuthAccount,
    TokenStore,
    WithAccount,
} from './types.js'
import { accountNotFoundError } from './user-flag.js'

export type AttachAccountListContext<TAccount extends AuthAccount> = AttachContextBase & {
    /** Every stored account with its default marker, in store order. */
    accounts: ReadonlyArray<{ account: TAccount; isDefault: boolean }>
    /** The default account's ref (its `id`), or `null` when nothing is stored. */
    default: AccountRef | null
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
    onDefaultSet?(ctx: AttachContextBase & { ref: AccountRef }): void | Promise<void>
}

/** Split the parsed Commander options into the canonical machine-output view + the remaining consumer flags. */
function splitViewFlags(cmd: Record<string, unknown>): {
    view: Required<ViewOptions>
    flags: Record<string, unknown>
} {
    const { json, ndjson, ...flags } = cmd
    return { view: { json: Boolean(json), ndjson: Boolean(ndjson) }, flags }
}

/** The canonical one-line human representation of an account, shared by `list` and `current`. */
function formatAccountLine(account: AuthAccount, isDefault: boolean): string {
    return `${account.label ?? account.id} (id:${account.id})${isDefault ? ' (default)' : ''}`
}

/**
 * Build the machine-output payload for one account — `renderJson` when supplied,
 * else the default `{ account, isDefault }` — and validate that it serializes,
 * so `--json` and `--ndjson` fail identically on a non-serializable result
 * (top-level `undefined`, a circular object, a `BigInt`, …) with a typed
 * `CliError('INVALID_TYPE', …)` rather than a raw `TypeError` leaking out of
 * `formatJson` / `formatNdjson`. Shared by `list` and `current` so the two
 * can't drift on validation or error text.
 */
function buildAccountPayload<TAccount extends AuthAccount>(
    ctx: { account: TAccount; isDefault: boolean; flags: Record<string, unknown> },
    renderJson?: (input: {
        account: TAccount
        isDefault: boolean
        flags: Record<string, unknown>
    }) => unknown,
): unknown {
    const payload = renderJson
        ? renderJson(ctx)
        : { account: ctx.account, isDefault: ctx.isDefault }
    let serializable: boolean
    try {
        serializable = JSON.stringify(payload) !== undefined
    } catch {
        serializable = false
    }
    if (!serializable) {
        throw new CliError(
            'INVALID_TYPE',
            `renderJson returned a non-serializable value for account "${ctx.account.id}".`,
        )
    }
    return payload
}

/**
 * Resolve the active account plus its effective-default status. Prefers the
 * store's token-free `activeAccount` resolver (a single metadata read); falls
 * back to `active()` + `list()` for stores that don't implement it.
 */
async function resolveActiveAccount<TAccount extends AuthAccount>(
    store: TokenStore<TAccount>,
): Promise<{ account: TAccount; isDefault: boolean } | null> {
    if (store.activeAccount) return store.activeAccount()
    const snapshot = await store.active()
    if (!snapshot) return null
    const accounts = await store.list()
    return {
        account: snapshot.account,
        isDefault: accounts.some(
            (entry) => entry.account.id === snapshot.account.id && entry.isDefault,
        ),
    }
}

function defaultListText<TAccount extends AuthAccount>(
    ctx: AttachAccountListContext<TAccount>,
): string[] {
    if (ctx.accounts.length === 0) return ['No accounts stored.']
    return ctx.accounts.map(({ account, isDefault }) => formatAccountLine(account, isDefault))
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
            const toPayload = (entry: { account: TAccount; isDefault: boolean }) =>
                buildAccountPayload(
                    { account: entry.account, isDefault: entry.isDefault, flags },
                    options.renderJson,
                )
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

export type AttachAccountCurrentContext<TAccount extends AuthAccount> = WithAccount<TAccount> & {
    /** Whether the active account is the store's effective default. */
    isDefault: boolean
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
     * Called when nothing resolves as the active account. Default behaviour
     * throws `CliError('NOT_AUTHENTICATED', …)`. Consumers with out-of-store
     * credential sources (env var, legacy single-user creds) use this hook to
     * render those cases — mirroring `attachStatusCommand`.
     */
    onNotAuthenticated?(ctx: AttachContextBase): void | Promise<void>
}

/**
 * Attach `current` as a subcommand of `parent` (typically an `account` group).
 * Resolves the active account token-free via `store.activeAccount()` when the
 * store implements it (falling back to `store.active()` + `store.list()`), so
 * the `(default)` marker stays identical to `account list` without paying a
 * token read this command never uses. No selector — the active account is
 * whatever the store resolves by default. Dispatches to `renderText` (human) or
 * `renderJson` (machine); `--json` wins when both flags are present. When
 * nothing resolves it invokes `onNotAuthenticated` (or throws
 * `NOT_AUTHENTICATED`). Returns the new `Command` so the consumer can chain.
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
            const resolved = await resolveActiveAccount(options.store)
            if (!resolved) {
                if (options.onNotAuthenticated) {
                    await options.onNotAuthenticated({ view, flags })
                    return
                }
                throw new CliError('NOT_AUTHENTICATED', 'Not signed in.')
            }
            const ctx: AttachAccountCurrentContext<TAccount> = {
                account: resolved.account,
                isDefault: resolved.isDefault,
                view,
                flags,
            }
            if (view.json || view.ndjson) {
                const payload = buildAccountPayload(
                    { account: ctx.account, isDefault: ctx.isDefault, flags },
                    options.renderJson,
                )
                console.log(view.json ? formatJson(payload) : formatNdjson([payload]))
                return
            }
            const text = options.renderText
                ? options.renderText(ctx)
                : formatAccountLine(ctx.account, ctx.isDefault)
            const lines = typeof text === 'string' ? [text] : text
            for (const line of lines) console.log(line)
        })
}

export type AttachAccountRemoveContext<TAccount extends AuthAccount> = WithAccount<TAccount> & {
    /** The raw `<ref>` positional the user typed. */
    ref: AccountRef
    /** Whether the removed account was the default before clearing. */
    wasDefault: boolean
}

export type AttachAccountRemoveCommandOptions<TAccount extends AuthAccount = AuthAccount> = {
    store: TokenStore<TAccount>
    description?: string
    /**
     * Human-mode renderer over the removed account. Defaults to
     * `✓ Removed <label ?? id>`, with a ` (default)` marker when the removed
     * account was the default (the marker only states what *was* removed — it
     * makes no claim about whether a survivor is now the implicit default).
     * Consumers override to localise the wording (e.g. add a CLI-specific "set a
     * new default" hint). Not called under `--json` / `--ndjson`.
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
 * group). Delegates resolution + deletion to `store.clear(ref)`, which the
 * contract defines as token-free and atomic: it returns the removed account
 * (plus whether it was the effective default) or `null` when `ref` matched
 * nothing. Routing everything through `clear` means a broken/unreadable keyring
 * entry stays removable (no token read), and the store — not the attacher —
 * owns ref-matching, so there's no before/after `list()` diff to race against a
 * concurrent mutation. A `null` return surfaces as `ACCOUNT_NOT_FOUND`.
 * `--json` emits `{ ok: true, removed: <id> }`; `--ndjson` is silent
 * (success-action convention, matching `use`); `--json` wins when both are
 * present. Returns the new `Command` so the consumer can chain.
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
            const cleared = await options.store.clear(ref)
            if (!cleared) throw accountNotFoundError(ref)
            const ctx: AttachAccountRemoveContext<TAccount> = {
                account: cleared.account,
                ref,
                wasDefault: cleared.wasDefault,
                view,
                flags,
            }
            // `--json` emits the envelope; pure `--ndjson` is silent (success-
            // action convention); human runs the thunk. The guard skips the
            // silent case so `emitView`'s own `--ndjson` branch never fires.
            if (view.json || !view.ndjson) {
                emitView(view, { ok: true, removed: cleared.account.id }, () => {
                    const name = cleared.account.label ?? cleared.account.id
                    const removedLine = `✓ Removed ${name}${ctx.wasDefault ? ' (default)' : ''}`
                    const text = options.renderText ? options.renderText(ctx) : removedLine
                    return typeof text === 'string' ? [text] : text
                })
            }
            await options.onRemoved?.(ctx)
        })
}
