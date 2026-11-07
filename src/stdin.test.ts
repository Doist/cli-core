import { describe, expect, it } from 'vitest'

import { readStdin } from './stdin.js'
import { mockStdin } from './testing/stdin.js'

describe('readStdin', () => {
    it('reads piped input to the end, joining its chunks', async () => {
        mockStdin(['# Title\n\n', 'Body line one.\n', 'Body line two.\n'])
        expect(await readStdin()).toBe('# Title\n\nBody line one.\nBody line two.\n')
    })

    it('returns the input untrimmed', async () => {
        mockStdin('  indented\n\n\n')
        expect(await readStdin()).toBe('  indented\n\n\n')
    })

    it('returns an empty string for empty piped input', async () => {
        mockStdin('')
        expect(await readStdin()).toBe('')
    })

    it('decodes a UTF-8 character split across two chunks', async () => {
        // "é" is 0xC3 0xA9; a reader that decodes chunk by chunk turns each half into U+FFFD.
        mockStdin([new Uint8Array([0x63, 0x61, 0x66, 0xc3]), new Uint8Array([0xa9])])
        expect(await readStdin()).toBe('café')
    })

    it('throws STDIN_IS_TTY instead of waiting when stdin is a terminal', async () => {
        mockStdin('typed but never sent', { isTTY: true })
        await expect(readStdin()).rejects.toMatchObject({
            name: 'CliError',
            code: 'STDIN_IS_TTY',
            message: 'Expected input piped to stdin, but stdin is an interactive terminal',
            hints: ['Pipe the content in, e.g. `cat notes.md | …`'],
        })
    })
})
