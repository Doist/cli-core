import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { printEmpty } from './empty.js'
import { describeEmptyMachineOutput } from './testing.js'

const HUMAN_MESSAGE = 'No threads in inbox.'

// The 3-test contract for `printEmpty` is asserted via the shared helper —
// running the helper here doubles as a smoke test that the helper itself
// works against a known-good implementation.
describeEmptyMachineOutput('printEmpty (contract via describeEmptyMachineOutput)', {
    setup: () => {},
    run: async (extraArgs) => {
        printEmpty({
            options: {
                json: extraArgs.includes('--json'),
                ndjson: extraArgs.includes('--ndjson'),
            },
            message: HUMAN_MESSAGE,
        })
    },
    humanMessage: HUMAN_MESSAGE,
})

describe('printEmpty (extras)', () => {
    let captured = ''
    let consoleSpy: ReturnType<typeof vi.spyOn> | undefined
    let writeSpy: ReturnType<typeof vi.spyOn> | undefined

    beforeEach(() => {
        captured = ''
        consoleSpy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
            captured += `${args.map((a) => (typeof a === 'string' ? a : String(a))).join(' ')}\n`
        })
        writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(((
            chunk: string | Uint8Array,
        ): boolean => {
            captured += typeof chunk === 'string' ? chunk : chunk.toString()
            return true
        }) as typeof process.stdout.write)
    })

    afterEach(() => {
        consoleSpy?.mockRestore()
        writeSpy?.mockRestore()
        consoleSpy = undefined
        writeSpy = undefined
    })

    it('prefers --json over --ndjson when both flags are set', () => {
        printEmpty({ options: { json: true, ndjson: true }, message: 'unused' })
        expect(captured).toBe('[]\n')
    })
})
