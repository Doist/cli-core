import { Command } from 'commander'
import { afterEach, beforeEach, vi } from 'vitest'

// Shared test scaffolding for the Commander attacher suites. Internal-only
// (under `src/test-support/`, excluded from the build).

type Spy = ReturnType<typeof vi.spyOn>

/**
 * Own the `beforeEach`/`afterEach` spy lifecycle: `register` creates + configures
 * a fresh spy before each test (where the target's types are concrete, so no
 * casts), and the spy is restored afterwards. Returns a getter for the live spy
 * — call it inside the test body, since a new spy is installed per test.
 */
function installSpy(register: () => Spy): () => Spy {
    let spy: Spy
    beforeEach(() => {
        spy = register()
    })
    afterEach(() => {
        spy.mockRestore()
    })
    return () => spy
}

/**
 * Silence + spy on `console.log`. Call once at the top of a `describe`:
 *
 * ```ts
 * const logSpy = installConsoleLogSpy()
 * it('...', () => { expect(logSpy()).toHaveBeenCalledWith('…') })
 * ```
 */
export function installConsoleLogSpy(): () => Spy {
    return installSpy(() => vi.spyOn(console, 'log').mockImplementation(() => {}))
}

/** Same as {@link installConsoleLogSpy} for `process.stdout.write` (pipe-safe output). */
export function installStdoutSpy(): () => Spy {
    return installSpy(() => vi.spyOn(process.stdout, 'write').mockImplementation(() => true))
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
