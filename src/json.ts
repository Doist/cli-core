import { writeLines } from './stream.js'

function stringifyNdjsonItem(item: unknown, index: number, source: string): string {
    const line = JSON.stringify(item)
    if (line === undefined) {
        throw new TypeError(
            `${source}: item at index ${index} is not JSON-serializable (got undefined, function, or symbol)`,
        )
    }
    return line
}

/**
 * Pretty-print a value as JSON with 2-space indentation. Matches the canonical
 * `--json` output style used across the Doist CLIs.
 *
 * Throws if `value` cannot be serialized (top-level `undefined`, a function,
 * a symbol, or an object whose `toJSON()` returns `undefined`) so the
 * `string` return type is honoured.
 */
export function formatJson(value: unknown): string {
    const result = JSON.stringify(value, null, 2)
    if (result === undefined) {
        throw new TypeError(
            'formatJson: value is not JSON-serializable (got undefined, function, or symbol at top level)',
        )
    }
    return result
}

/**
 * Format an array as newline-delimited JSON (NDJSON): one JSON value per line,
 * separated by `\n`, with no trailing newline. Matches the canonical `--ndjson`
 * output style used across the Doist CLIs.
 *
 * Throws if any item cannot be serialized — surfacing the bad index instead of
 * silently emitting blank lines that would corrupt the output stream.
 */
export function formatNdjson(items: readonly unknown[]): string {
    return items.map((item, index) => stringifyNdjsonItem(item, index, 'formatNdjson')).join('\n')
}

/** Write newline-delimited JSON to stdout while respecting stream backpressure. */
export async function outputNdjson(items: Iterable<unknown>): Promise<void> {
    await writeLines(items, (item, index) => stringifyNdjsonItem(item, index, 'outputNdjson'))
}
