import { Readable } from 'node:stream'
import { vi } from 'vitest'

import { captureSpy, type Spy } from './capture-spy.js'

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
 * as a real pipe delivers them, and empty input emits no chunks at all; pass
 * `Uint8Array` chunks to control the byte boundaries (e.g. a UTF-8 character
 * split across two reads).
 */
export function mockStdin(
    input: string | readonly (string | Uint8Array)[],
    options: MockStdinOptions = {},
): Spy {
    const chunks = typeof input === 'string' ? [input] : input
    // Byte mode, like a real pipe: `Readable.from` defaults to object mode,
    // which would emit a zero-length chunk for empty input.
    const bytes = Readable.from(
        chunks.map((chunk) => Buffer.from(chunk)),
        { objectMode: false },
    )
    const stream = Object.assign(bytes, { isTTY: options.isTTY ?? false })
    // A Readable carrying `isTTY` is all that stdin readers touch; the rest of
    // `tty.ReadStream` (raw mode, fd) has no meaning for a fake pipe.
    return captureSpy(() =>
        vi
            .spyOn(process, 'stdin', 'get')
            .mockReturnValue(stream as unknown as typeof process.stdin),
    )
}
