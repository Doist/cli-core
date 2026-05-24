import { describe, expect, it, vi } from 'vitest'

import { captureConsole, captureStream } from './console.js'

describe('captureConsole', () => {
    it('silences console.log and records calls', () => {
        const spy = captureConsole()
        console.log('hello', 'world')
        expect(spy).toHaveBeenCalledWith('hello', 'world')
    })

    it('can spy on other console methods', () => {
        const spy = captureConsole('error')
        console.error('boom')
        expect(spy).toHaveBeenCalledWith('boom')
    })
})

describe('captureStream', () => {
    it('silences the stream, returns true, and records writes', () => {
        const spy = captureStream('stdout')
        const result = process.stdout.write('chunk')
        expect(result).toBe(true)
        expect(spy).toHaveBeenCalledWith('chunk')
    })

    it('invokes a trailing write callback — write(chunk, cb)', async () => {
        captureStream('stderr')
        const cb = vi.fn()
        process.stderr.write('chunk', cb)
        await Promise.resolve()
        expect(cb).toHaveBeenCalledTimes(1)
    })

    it('invokes a trailing write callback — write(chunk, encoding, cb)', async () => {
        captureStream('stdout')
        const cb = vi.fn()
        process.stdout.write('chunk', 'utf8', cb)
        await Promise.resolve()
        expect(cb).toHaveBeenCalledTimes(1)
    })
})
