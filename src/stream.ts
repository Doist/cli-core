import { once } from 'node:events'

const FALLBACK_CHUNK_SIZE = 16 * 1024

export async function writeLines<T>(
    items: Iterable<T>,
    formatLine: (item: T, index: number) => string,
): Promise<void> {
    const chunkSize = process.stdout.writableHighWaterMark || FALLBACK_CHUNK_SIZE
    let chunk = ''
    let chunkBytes = 0
    let index = 0

    const flush = async (): Promise<void> => {
        if (!chunk) return
        const output = chunk
        chunk = ''
        chunkBytes = 0
        if (!process.stdout.write(output)) {
            await once(process.stdout, 'drain')
        }
    }

    for (const item of items) {
        const line = `${formatLine(item, index)}\n`
        const lineBytes = Buffer.byteLength(line)
        index += 1

        if (chunk && chunkBytes + lineBytes > chunkSize) {
            await flush()
        }

        chunk += line
        chunkBytes += lineBytes

        if (chunkBytes >= chunkSize) {
            await flush()
        }
    }

    await flush()
}
