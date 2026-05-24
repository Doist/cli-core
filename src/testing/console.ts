import { onTestFinished, vi } from 'vitest'

type ConsoleMethod = 'log' | 'error' | 'warn' | 'info'
type StdStream = 'stdout' | 'stderr'

/**
 * Spy on a console method, silence it, and auto-restore when the current test
 * finishes. Returns the spy so `.mock.calls` assertions keep working. Call it
 * inside a test or `beforeEach` — `onTestFinished` throws at `describe` top-level.
 */
export function captureConsole(method: ConsoleMethod = 'log'): ReturnType<typeof vi.spyOn> {
    const spy = vi.spyOn(console, method).mockImplementation(() => {})
    onTestFinished(() => {
        spy.mockRestore()
    })
    return spy
}

/** Same as {@link captureConsole} for `process.stdout`/`process.stderr.write` (pipe-safe paths). */
export function captureStream(stream: StdStream = 'stdout'): ReturnType<typeof vi.spyOn> {
    const spy = vi
        .spyOn(process[stream], 'write')
        .mockImplementation((() => true) as typeof process.stdout.write)
    onTestFinished(() => {
        spy.mockRestore()
    })
    return spy
}
