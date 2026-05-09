import { formatJson, formatNdjson } from './json.js'

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
