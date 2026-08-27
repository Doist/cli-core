import { CliError } from './errors.js'
import { formatJson, formatNdjson } from './json.js'

/** Canonical output modes shared by Doist CLIs. */
export const OUTPUT_MODES = ['human', 'json', 'ndjson', 'ids-only'] as const

/** A canonical output mode shared by Doist CLIs. */
export type OutputMode = (typeof OUTPUT_MODES)[number]

/**
 * Shared shape for commands that respect the canonical machine-output flags.
 * Seeded narrow so the type only declares what cli-core helpers actually read
 * today; will grow (`full?`, `raw?`, etc.) as the global-args parser extraction
 * lands (see EXTRACTION_ROADMAP.md, Tier 1).
 *
 * Per-CLI `ViewOptions` types should extend this rather than re-declare the
 * `json` / `ndjson` fields.
 */
export type ViewOptions = {
    json?: boolean
    ndjson?: boolean
}

/** Shared shape for list commands that can emit only stable result IDs. */
export type ListViewOptions = ViewOptions & {
    idsOnly?: boolean
}

const OUTPUT_FLAGS: ReadonlyArray<{
    enabled: (options: ListViewOptions) => boolean
    flag: string
    mode: Exclude<OutputMode, 'human'>
}> = [
    { enabled: (options) => Boolean(options.json), flag: '--json', mode: 'json' },
    { enabled: (options) => Boolean(options.ndjson), flag: '--ndjson', mode: 'ndjson' },
    { enabled: (options) => Boolean(options.idsOnly), flag: '--ids-only', mode: 'ids-only' },
]

/** Resolve the selected canonical output mode and reject conflicting flags. */
export function resolveOutputMode(options: ListViewOptions): OutputMode {
    const selected = OUTPUT_FLAGS.filter(({ enabled }) => enabled(options))
    if (selected.length > 1) {
        throw new CliError(
            'CONFLICTING_OPTIONS',
            `Options ${selected.map(({ flag }) => flag).join(', ')} are mutually exclusive.`,
        )
    }
    return selected[0]?.mode ?? 'human'
}

/**
 * `--json` / `--ndjson` / human emitter. `humanLines` is a thunk so the
 * human-mode strings (chalk colouring, conditional formatting) are never
 * built when machine output is requested.
 */
export function emitView(
    view: ViewOptions,
    payload: Record<string, unknown>,
    humanLines: () => ReadonlyArray<string>,
): void {
    if (view.json) {
        console.log(formatJson(payload))
        return
    }
    if (view.ndjson) {
        console.log(formatNdjson([payload]))
        return
    }
    for (const line of humanLines()) console.log(line)
}
