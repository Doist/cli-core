import { formatJson, formatNdjson } from '../../json.js'
import type { ViewOptions } from '../../options.js'

/**
 * Centralised `--json` / `--ndjson` / human emitter. `humanLines` is a thunk
 * so the human-mode strings (chalk colouring, conditional formatting) are
 * not built when machine output is requested.
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
