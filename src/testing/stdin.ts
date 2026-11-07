import { Readable } from 'node:stream'
import type { MockInstance } from 'vitest'
import { onTestFinished, vi } from 'vitest'

export type MockStdinOptions = {
    /** Make `process.stdin.isTTY` true, standing in for an interactive terminal. */
    isTTY?: boolean
}

/**
 * Replace `process.stdin` with a stream that yields `input`, and restore it
 * when the current test finishes. Call inside a test or `beforeEach`.
 *
 * `process.stdin.isTTY` is `false` unless `isTTY: true` is passed, so by
 * default the stream looks like a pipe. String chunks are emitted as Buffers,
 * as a real pipe delivers them; pass `Uint8Array` chunks to control the byte
 * boundaries (e.g. a UTF-8 character split across two reads).
 */
export function mockStdin(
    input: string | readonly (string | Uint8Array)[],
    options: MockStdinOptions = {},
): MockInstance {
    const chunks = typeof input === 'string' ? [input] : input
    const stream = Object.assign(Readable.from(chunks.map((chunk) => Buffer.from(chunk))), {
        isTTY: options.isTTY ?? false,
    })
    // A Readable carrying `isTTY` is all that stdin readers touch; the rest of
    // `tty.ReadStream` (raw mode, fd) has no meaning for a fake pipe.
    const spy = vi
        .spyOn(process, 'stdin', 'get')
        .mockReturnValue(stream as unknown as typeof process.stdin)
    onTestFinished(() => {
        spy.mockRestore()
    })
    return spy
}
