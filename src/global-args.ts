/**
 * Centralized, type-safe parsing of well-known global CLI flags shared
 * across the Doist CLIs.
 *
 * Replaces scattered `process.argv.includes()` checks with a single parse
 * that correctly handles grouped short flags (e.g., `-vq`), repeated flags
 * (e.g., `-vvv`), `--flag=value` forms, and avoids false-positives from
 * option values.
 *
 * The parser is pure — pass an explicit argv for testing, or use
 * `createGlobalArgsStore` for the lazy-cached singleton pattern. The store
 * is generic so per-CLI extensions (e.g. todoist's `--user`/`--raw`,
 * twist's `--non-interactive`) can layer their own fields over `GlobalArgs`.
 */

import type { ViewOptions } from './options.js'
import { isCI } from './terminal.js'

export type GlobalArgs = Required<Pick<ViewOptions, 'json' | 'ndjson'>> & {
    quiet: boolean
    verbose: 0 | 1 | 2 | 3 | 4
    accessible: boolean
    noSpinner: boolean
    /** false = absent, true = present without path, string = path. */
    progressJsonl: string | true | false
    /**
     * Account selector parsed from `--user <ref>` / `--user=<ref>`.
     * `undefined` when the flag was absent or supplied without a value.
     * Single-user CLIs see the same field — their `TokenStore` either
     * matches the ref against the one stored account or throws
     * `CliError('ACCOUNT_NOT_FOUND', …)`.
     */
    user?: string
}

const SHORT_FLAGS: Record<string, 'quiet' | 'verbose'> = {
    q: 'quiet',
    v: 'verbose',
}

/**
 * Whether `token` qualifies as the value for a space-separated long option
 * (e.g. `--user me`). Treats `undefined`, the `--` terminator, and anything
 * starting with `-` as "no value" so the parser doesn't swallow a following
 * flag or positional separator.
 */
function isFlagValue(token: string | undefined): token is string {
    return token !== undefined && token !== '--' && !token.startsWith('-')
}

/**
 * Parse well-known global flags from `argv`. Pure — pass an explicit array
 * for testing, or omit to read `process.argv.slice(2)`.
 *
 * The parser scans the entire argv: a CLI-specific positional that happens
 * to look like a global short flag (`td comment add 123 -q`) will flip the
 * matching global state. Workaround: use the standard `--` terminator
 * (`td comment add 123 -- -q`) so the parser stops before the positional.
 * The trade-off is intentional — callers run this before Commander has
 * parsed argv, so we can't yet distinguish positionals from option values.
 *
 * `--progress-jsonl` accepts only the bare form (output to stderr) and the
 * `--progress-jsonl=path` form. The space-separated `--progress-jsonl path`
 * form is intentionally unsupported because it silently consumes the next
 * positional argument (e.g., `td task add --progress-jsonl "Buy milk"`
 * would treat `Buy milk` as a file path).
 *
 * `--user <ref>` (and `--user=<ref>`) is always recognised. The space form
 * does NOT consume the following token if it begins with `-` (so
 * `--user --json` leaves `user` undefined rather than swallowing `--json`)
 * and is ignored after the `--` terminator. Pair with `stripUserFlag` when
 * forwarding argv to Commander without an attached root `--user` option.
 */
export function parseGlobalArgs(argv?: string[]): GlobalArgs {
    const args = argv ?? process.argv.slice(2)

    const result: GlobalArgs = {
        json: false,
        ndjson: false,
        quiet: false,
        verbose: 0,
        accessible: false,
        noSpinner: false,
        progressJsonl: false,
    }

    for (let i = 0; i < args.length; i++) {
        const arg = args[i]

        if (arg === '--') break

        if (arg === '--json') {
            result.json = true
        } else if (arg === '--ndjson') {
            result.ndjson = true
        } else if (arg === '--quiet') {
            result.quiet = true
        } else if (arg === '--verbose') {
            result.verbose = Math.min(result.verbose + 1, 4) as GlobalArgs['verbose']
        } else if (arg === '--accessible') {
            result.accessible = true
        } else if (arg === '--no-spinner') {
            result.noSpinner = true
        } else if (arg === '--progress-jsonl') {
            result.progressJsonl = true
        } else if (arg.startsWith('--progress-jsonl=')) {
            result.progressJsonl = arg.slice('--progress-jsonl='.length)
        } else if (arg === '--user') {
            // Skip when the next token is absent, another flag, or the `--`
            // terminator — those are all "no value supplied" scenarios that
            // we treat as no-ops rather than swallowing the following token.
            const next = args[i + 1]
            if (isFlagValue(next)) {
                result.user = next
                i++
            }
        } else if (arg.startsWith('--user=')) {
            const value = arg.slice('--user='.length)
            if (value !== '') result.user = value
        } else if (arg.length > 1 && arg[0] === '-' && arg[1] !== '-') {
            // Short-flag group: -v, -vq, -vvv, etc. Unknown shorts are
            // silently ignored — they belong to Commander or subcommands.
            for (let j = 1; j < arg.length; j++) {
                const mapped = SHORT_FLAGS[arg[j]]
                if (mapped === 'verbose') {
                    result.verbose = Math.min(result.verbose + 1, 4) as GlobalArgs['verbose']
                } else if (mapped === 'quiet') {
                    result.quiet = true
                }
            }
        }
    }

    return result
}

/**
 * Remove pre-subcommand `--user <ref>` / `--user=<ref>` tokens from `argv`
 * and return the cleaned array. Used when `--user` was parsed via
 * `parseGlobalArgs` but Commander has no `--user` option attached at the
 * root program (the common case for multi-user CLIs), so forwarding the raw
 * argv would trip `unknown option` errors.
 *
 * Stripping stops at the first non-flag positional (the subcommand name) or
 * the `--` terminator — everything from that point onwards is copied
 * verbatim so subcommand-level `--user` attached by the auth attachers
 * still reaches Commander. Pure — does not mutate the input array.
 */
export function stripUserFlag(argv: string[]): string[] {
    const result: string[] = []
    let i = 0
    while (i < argv.length) {
        const arg = argv[i]
        // First non-flag positional ends the global-args region; subcommand
        // arguments — including subcommand-level `--user` parsed by the
        // attacher itself — must reach Commander untouched.
        if (arg === '--' || (arg.length > 0 && arg[0] !== '-')) {
            for (let j = i; j < argv.length; j++) result.push(argv[j])
            break
        }
        if (arg === '--user') {
            i += isFlagValue(argv[i + 1]) ? 2 : 1
            continue
        }
        if (arg.startsWith('--user=')) {
            i += 1
            continue
        }
        result.push(arg)
        i += 1
    }
    return result
}

export type GlobalArgsStore<T extends GlobalArgs = GlobalArgs> = {
    get(): T
    /** Clear the cached parse result. Call from test teardown. */
    reset(): void
}

/**
 * Lazy-cached singleton wrapper around a parser function. Each CLI builds
 * one store at startup; callers read via `store.get()`. Tests reset between
 * cases so a mutated `process.argv` is re-parsed on next access.
 *
 * ```ts
 * // Vanilla — canonical fields only.
 * const store = createGlobalArgsStore()
 * export const isJsonMode = () => store.get().json
 * export const resetGlobalArgs = store.reset
 *
 * // Extended — layer CLI-specific fields over GlobalArgs.
 * type CliArgs = GlobalArgs & { user: string | undefined; raw: boolean }
 * const store = createGlobalArgsStore<CliArgs>(() => {
 *     const base = parseGlobalArgs()
 *     const argv = process.argv.slice(2)
 *     return { ...base, user: parseUser(argv), raw: argv.includes('--raw') }
 * })
 * ```
 */
export function createGlobalArgsStore(): GlobalArgsStore<GlobalArgs>
export function createGlobalArgsStore<T extends GlobalArgs>(parse: () => T): GlobalArgsStore<T>
export function createGlobalArgsStore<T extends GlobalArgs>(parse?: () => T): GlobalArgsStore<T> {
    // Overloads ensure callers passing a custom `T` must supply a matching
    // parser; the implementation default only kicks in for the no-arg
    // canonical case where `T` collapses to `GlobalArgs`.
    const parser = parse ?? (parseGlobalArgs as () => T)
    let cached: T | null = null
    return {
        get() {
            if (cached === null) cached = parser()
            return cached
        },
        reset() {
            cached = null
        },
    }
}

export function isProgressJsonlEnabled(args: GlobalArgs): boolean {
    return args.progressJsonl !== false
}

export function getProgressJsonlPath(args: GlobalArgs): string | undefined {
    return typeof args.progressJsonl === 'string' ? args.progressJsonl : undefined
}

export type AccessibleGateOptions = {
    /** Env var that, when set to `'1'`, forces accessible mode (e.g. `TD_ACCESSIBLE`). */
    envVar: string
    getArgs: () => GlobalArgs
}

/**
 * Build an `isAccessible` predicate that combines the `--accessible` flag
 * with a CLI-specific opt-in env var (e.g. `TD_ACCESSIBLE=1`).
 *
 * ```ts
 * const store = createGlobalArgsStore()
 * export const isAccessible = createAccessibleGate({
 *     envVar: 'TD_ACCESSIBLE',
 *     getArgs: store.get,
 * })
 * ```
 */
export function createAccessibleGate(opts: AccessibleGateOptions): () => boolean {
    return () => process.env[opts.envVar] === '1' || opts.getArgs().accessible
}

export type SpinnerGateOptions = {
    /** Env var that, when set to `'false'`, force-disables the spinner (e.g. `TD_SPINNER`). */
    envVar: string
    getArgs: () => GlobalArgs
    /**
     * CLI-specific extra disable triggers — e.g. twist returns true when
     * `--non-interactive` is set. Evaluated only after the canonical checks
     * already returned false.
     */
    extraTriggers?: () => boolean
}

/**
 * Build a `shouldDisableSpinner` predicate. Disables on:
 *   - env var equals `'false'`
 *   - `isCI()`
 *   - any of `--json`, `--ndjson`, `--no-spinner`, `--progress-jsonl`, `--verbose`
 *   - `extraTriggers?.()` returning true
 *
 * Pair with `createSpinner({ isDisabled })` from `./spinner.js`.
 *
 * ```ts
 * const store = createGlobalArgsStore()
 *
 * // todoist: env var + canonical flags only.
 * const shouldDisableSpinner = createSpinnerGate({
 *     envVar: 'TD_SPINNER',
 *     getArgs: store.get,
 * })
 *
 * // twist: also disable when --non-interactive is set.
 * const shouldDisableSpinner = createSpinnerGate({
 *     envVar: 'TW_SPINNER',
 *     getArgs: store.get,
 *     extraTriggers: () => isNonInteractive(),
 * })
 *
 * const { withSpinner } = createSpinner({ isDisabled: shouldDisableSpinner })
 * ```
 */
export function createSpinnerGate(opts: SpinnerGateOptions): () => boolean {
    return () => {
        if (process.env[opts.envVar] === 'false') return true
        if (isCI()) return true
        const args = opts.getArgs()
        if (
            args.json ||
            args.ndjson ||
            args.noSpinner ||
            isProgressJsonlEnabled(args) ||
            args.verbose > 0
        ) {
            return true
        }
        return opts.extraTriggers?.() ?? false
    }
}
