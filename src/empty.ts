import { formatJson } from './json.js'
import { type ListViewOptions, resolveOutputMode } from './options.js'

/**
 * Gate the empty-state print on the active output mode:
 *   --json   → prints exactly `'[]'`
 *   --ndjson → prints nothing (no stray newline; ndjson EOF = end of stream)
 *   --ids-only → prints nothing
 *   neither  → prints the human-readable message
 *
 * Use at every list/array empty-result branch so machine consumers never see
 * human strings on stdout when they asked for a machine-output mode.
 */
export function printEmpty({
    options,
    message,
}: {
    options: ListViewOptions
    message: string
}): void {
    const outputMode = resolveOutputMode(options)
    if (outputMode === 'json') {
        console.log(formatJson([]))
        return
    }
    if (outputMode === 'ndjson' || outputMode === 'ids-only') {
        return
    }
    console.log(message)
}
