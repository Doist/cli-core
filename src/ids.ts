/** Format stable IDs as one value per line, with no trailing newline. */
export function formatIds<T>(items: readonly T[], getId: (item: T) => string | number): string {
    return items.map((item) => String(getId(item))).join('\n')
}

/**
 * Write stable IDs to stdout and an optional pagination notice to stderr.
 * Empty results write nothing to stdout.
 */
export function outputIds<T>(
    items: readonly T[],
    getId: (item: T) => string | number,
    paginationNotice = '',
): void {
    const output = formatIds(items, getId)
    if (output) console.log(output)
    if (paginationNotice) console.error(paginationNotice)
}
