import { afterEach, describe, expect, it, vi } from 'vitest'
import { writeLines } from './stream.js'

describe('writeLines', () => {
    afterEach(() => {
        vi.restoreAllMocks()
    })

    it('waits for stdout to drain before writing the next chunk', async () => {
        const write = vi
            .spyOn(process.stdout, 'write')
            .mockReturnValueOnce(false)
            .mockReturnValue(true)
        const firstLine = 'a'.repeat(process.stdout.writableHighWaterMark)

        const output = writeLines([firstLine, 'b'], (line) => line)

        expect(write).toHaveBeenCalledOnce()
        process.stdout.emit('drain')
        await output
        expect(write).toHaveBeenCalledTimes(2)
        expect(write).toHaveBeenLastCalledWith('b\n')
    })
})
