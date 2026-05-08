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

import { isCI } from './terminal.js'

export type GlobalArgs = {
    json: boolean
    ndjson: boolean
    quiet: boolean
    verbose: 0 | 1 | 2 | 3 | 4
    accessible: boolean
    noSpinner: boolean
    /** false = absent, true = present without path, string = path. */
    progressJsonl: string | true | false
}

const SHORT_FLAGS: Record<string, 'quiet' | 'verbose'> = {
    q: 'quiet',
    v: 'verbose',
}

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
        } else if (arg === '--progress-jsonl' || arg.startsWith('--progress-jsonl=')) {
            if (arg.includes('=')) {
                result.progressJsonl = arg.slice(arg.indexOf('=') + 1)
            } else if (i + 1 < args.length && !args[i + 1].startsWith('-')) {
                i++
                result.progressJsonl = args[i]
            } else {
                result.progressJsonl = true
            }
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
export function createGlobalArgsStore<T extends GlobalArgs = GlobalArgs>(
    parse: () => T = parseGlobalArgs as () => T,
): GlobalArgsStore<T> {
    let cached: T | null = null
    return {
        get() {
            if (cached === null) cached = parse()
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
            args.progressJsonl !== false ||
            args.verbose > 0
        ) {
            return true
        }
        return opts.extraTriggers?.() ?? false
    }
}
