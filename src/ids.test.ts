import { afterEach, describe, expect, it, vi } from 'vitest'
import { formatIds, outputIds } from './ids.js'

describe('formatIds', () => {
    it('formats string and numeric IDs one per line', () => {
        expect(formatIds([{ id: 'task-1' }, { id: 42 }], (item) => item.id)).toBe('task-1\n42')
    })

    it('returns an empty string for no results', () => {
        expect(formatIds([], (item: { id: string }) => item.id)).toBe('')
    })
})

describe('outputIds', () => {
    afterEach(() => {
        vi.restoreAllMocks()
    })

    it('writes IDs to stdout in one block', async () => {
        const write = vi.spyOn(process.stdout, 'write').mockReturnValue(true)

        await outputIds([{ id: 'a' }, { id: 'b' }], (item) => item.id)

        expect(write).toHaveBeenCalledOnce()
        expect(write).toHaveBeenCalledWith('a\nb\n')
    })

    it('writes nothing to stdout for no results', async () => {
        const write = vi.spyOn(process.stdout, 'write').mockReturnValue(true)

        await outputIds([], (item: { id: string }) => item.id)

        expect(write).not.toHaveBeenCalled()
    })

    it('writes pagination notices to stderr', async () => {
        const error = vi.spyOn(console, 'error').mockImplementation(() => {})

        await outputIds([], (item: { id: string }) => item.id, 'More results exist.')

        expect(error).toHaveBeenCalledWith('More results exist.')
    })
})
