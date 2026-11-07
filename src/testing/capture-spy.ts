import type { MockInstance } from 'vitest'
import { onTestFinished } from 'vitest'

// Use vitest's `MockInstance` (not `ReturnType<typeof vi.spyOn>`, which erases
// down to a shape whose `.mock.calls` is `any`) so consumers keep usable
// `.mock.calls` typing — making these a true drop-in for hand-rolled spies.
export type Spy = MockInstance

/**
 * Install a spy and auto-restore it when the current test finishes. Call
 * inside a test or `beforeEach` — `onTestFinished` throws at `describe`
 * top-level. Returns the spy so `.mock.calls` assertions keep working.
 *
 * Internal to the `./testing` helpers; the barrel does not re-export it.
 */
export function captureSpy(install: () => Spy): Spy {
    const spy = install()
    onTestFinished(() => {
        spy.mockRestore()
    })
    return spy
}
