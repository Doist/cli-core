/**
 * Pretty-print a value as JSON with 2-space indentation. Matches the canonical
 * `--json` output style used across the Doist CLIs.
 */
export function formatJson<T>(value: T): string {
    return JSON.stringify(value, null, 2)
}

/**
 * Format an array as newline-delimited JSON (NDJSON): one JSON value per line,
 * separated by `\n`, with no trailing newline. Matches the canonical `--ndjson`
 * output style used across the Doist CLIs.
 */
export function formatNdjson<T>(items: readonly T[]): string {
    return items.map((item) => JSON.stringify(item)).join('\n')
}
