import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { printEmpty } from './empty.js'

describe('printEmpty', () => {
    let logSpy: ReturnType<typeof vi.spyOn>

    beforeEach(() => {
        logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    })

    afterEach(() => {
        logSpy.mockRestore()
    })

    it('prints "[]" exactly once for --json', () => {
        printEmpty({ options: { json: true }, message: 'No threads in inbox.' })
        expect(logSpy).toHaveBeenCalledTimes(1)
        expect(logSpy).toHaveBeenCalledWith('[]')
    })

    it('does not call console.log at all for --ndjson (no stray newline)', () => {
        printEmpty({ options: { ndjson: true }, message: 'No threads in inbox.' })
        expect(logSpy).not.toHaveBeenCalled()
    })

    it('prints the human message when neither flag is set', () => {
        printEmpty({ options: {}, message: 'No threads in inbox.' })
        expect(logSpy).toHaveBeenCalledTimes(1)
        expect(logSpy).toHaveBeenCalledWith('No threads in inbox.')
    })

    it('prefers --json when both --json and --ndjson are set', () => {
        printEmpty({ options: { json: true, ndjson: true }, message: 'unused' })
        expect(logSpy).toHaveBeenCalledTimes(1)
        expect(logSpy).toHaveBeenCalledWith('[]')
    })
})
