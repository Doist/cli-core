import { onTestFinished, vi } from 'vitest'

type ConsoleMethod = 'log' | 'error' | 'warn' | 'info'
type StdStream = 'stdout' | 'stderr'
type Spy = ReturnType<typeof vi.spyOn>

/**
 * Install a silencing spy and auto-restore it when the current test finishes.
 * Call inside a test or `beforeEach` — `onTestFinished` throws at `describe`
 * top-level. Returns the spy so `.mock.calls` assertions keep working.
 */
function captureSpy(install: () => Spy): Spy {
    const spy = install()
    onTestFinished(() => {
        spy.mockRestore()
    })
    return spy
}

// `WriteStream.write` accepts an optional trailing callback (`write(chunk, cb)`
// or `write(chunk, encoding, cb)`) and invokes it asynchronously once the write
// is handled. Queue it on the microtask queue rather than calling inline so
// callback ordering matches the real stream.
function silentWrite(...args: unknown[]): boolean {
    const last = args.at(-1)
    if (typeof last === 'function') {
        queueMicrotask(last as (error?: Error | null) => void)
    }
    return true
}

/** Spy on a console method, silence it, and auto-restore when the test finishes. */
export function captureConsole(method: ConsoleMethod = 'log'): Spy {
    return captureSpy(() => vi.spyOn(console, method).mockImplementation(() => {}))
}

/** Same as {@link captureConsole} for `process.stdout`/`process.stderr.write` (pipe-safe paths). */
export function captureStream(stream: StdStream = 'stdout'): Spy {
    return captureSpy(() =>
        vi
            .spyOn(process[stream], 'write')
            .mockImplementation(silentWrite as typeof process.stdout.write),
    )
}
