import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type EmptyOutputConfig = {
    setup: () => void | Promise<void>
    run: (extraArgs: string[]) => Promise<void>
    humanMessage: string | RegExp
}

/**
 * Asserts the standard `printEmpty` contract for a command:
 *   --json   → writes exactly `'[]\n'` to stdout
 *   --ndjson → writes nothing to stdout (no stray newline)
 *   neither  → writes exactly the human message + `\n` to stdout
 *
 * Captures bytes from both `console.log` (which vitest intercepts before
 * it reaches the real stream) and `process.stdout.write`, so commands
 * using either pathway satisfy the contract.
 *
 * Spies are installed AFTER `setup` so any `vi.clearAllMocks()` inside
 * `setup` doesn't clobber them.
 */
export function describeEmptyMachineOutput(label: string, config: EmptyOutputConfig): void {
    describe(label, () => {
        let captured = ''
        let consoleSpy: ReturnType<typeof vi.spyOn> | undefined
        let writeSpy: ReturnType<typeof vi.spyOn> | undefined

        beforeEach(async () => {
            await config.setup()
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

        it('writes exactly "[]\\n" to stdout for --json', async () => {
            await config.run(['--json'])
            expect(captured).toBe('[]\n')
        })

        it('writes nothing to stdout for --ndjson (no stray newline)', async () => {
            await config.run(['--ndjson'])
            expect(captured).toBe('')
        })

        it('writes exactly the human message to stdout when no machine flag is set', async () => {
            await config.run([])
            if (typeof config.humanMessage === 'string') {
                expect(captured).toBe(`${config.humanMessage}\n`)
            } else {
                expect(captured).toMatch(config.humanMessage)
            }
        })
    })
}
