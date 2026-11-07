import { text } from 'node:stream/consumers'
import { describe, expect, it } from 'vitest'

import { mockStdin } from './stdin.js'

describe('mockStdin', () => {
    it('replaces process.stdin with a pipe that yields the given string', async () => {
        mockStdin('piped content\n')
        expect(process.stdin.isTTY).toBe(false)
        expect(await text(process.stdin)).toBe('piped content\n')
    })

    it('yields each chunk as a Buffer, as a real pipe does', async () => {
        mockStdin(['first ', 'second'])
        const chunks: unknown[] = []
        for await (const chunk of process.stdin) chunks.push(chunk)
        expect(chunks).toEqual([Buffer.from('first '), Buffer.from('second')])
    })

    it('passes raw byte chunks through unchanged', async () => {
        mockStdin([new Uint8Array([0xc3]), new Uint8Array([0xa9])])
        const chunks: unknown[] = []
        for await (const chunk of process.stdin) chunks.push(chunk)
        expect(chunks).toEqual([Buffer.from([0xc3]), Buffer.from([0xa9])])
    })

    it('stands in for an interactive terminal with isTTY: true', () => {
        mockStdin('', { isTTY: true })
        expect(process.stdin.isTTY).toBe(true)
    })
})
