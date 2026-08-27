import { writeLines } from './stream.js'

/** Format stable IDs as one value per line, with no trailing newline. */
export function formatIds<T>(items: readonly T[], getId: (item: T) => string | number): string {
    return items.map((item) => String(getId(item))).join('\n')
}

/**
 * Write stable IDs to stdout in bounded chunks, waiting when the stream applies
 * backpressure. Empty results write nothing; pagination notices go to stderr.
 */
export async function outputIds<T>(
    items: Iterable<T>,
    getId: (item: T) => string | number,
    paginationNotice = '',
): Promise<void> {
    await writeLines(items, (item) => String(getId(item)))
    if (paginationNotice) console.error(paginationNotice)
}
