import { formatJson } from './json.js'
import type { ViewOptions } from './options.js'

/**
 * Gate the empty-state print on the active output mode:
 *   --json   → prints exactly `'[]'`
 *   --ndjson → prints nothing (no stray newline; ndjson EOF = end of stream)
 *   neither  → prints the human-readable message
 *
 * Use at every list/array empty-result branch so machine consumers never see
 * human strings on stdout when they asked for `--json` / `--ndjson`.
 */
export function printEmpty({ options, message }: { options: ViewOptions; message: string }): void {
    if (options.json) {
        console.log(formatJson([]))
        return
    }
    if (options.ndjson) {
        return
    }
    console.log(message)
}
