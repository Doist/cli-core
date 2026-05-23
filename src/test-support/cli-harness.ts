import { Command } from 'commander'
import { afterEach, beforeEach, vi } from 'vitest'

// Shared test scaffolding for the Commander attacher suites. Internal-only
// (under `src/test-support/`, excluded from the build).

type Spy = ReturnType<typeof vi.spyOn>

/**
 * Register `beforeEach`/`afterEach` hooks that silence and spy on `console.log`,
 * returning a getter for the live spy. Call once at the top of a `describe`:
 *
 * ```ts
 * const logSpy = installConsoleLogSpy()
 * it('...', () => { expect(logSpy()).toHaveBeenCalledWith('…') })
 * ```
 */
export function installConsoleLogSpy(): () => Spy {
    let spy: Spy
    beforeEach(() => {
        spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    })
    afterEach(() => {
        spy.mockRestore()
    })
    return () => spy
}

/** Same as {@link installConsoleLogSpy} for `process.stdout.write` (pipe-safe output). */
export function installStdoutSpy(): () => Spy {
    let spy: Spy
    beforeEach(() => {
        spy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    })
    afterEach(() => {
        spy.mockRestore()
    })
    return () => spy
}

/**
 * Build a Commander program with `exitOverride()` and a single named parent
 * subcommand to attach to — the boilerplate every attacher suite repeats.
 */
export function buildProgram(parentName: string): { program: Command; parent: Command } {
    const program = new Command()
    program.exitOverride()
    const parent = program.command(parentName)
    return { program, parent }
}
