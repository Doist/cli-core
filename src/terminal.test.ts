import { afterEach, describe, expect, it, vi } from 'vitest'

import { isCI } from './terminal.js'

afterEach(() => {
    vi.unstubAllEnvs()
})

describe('isCI', () => {
    it('returns true when CI is set to a truthy value', () => {
        vi.stubEnv('CI', 'true')
        expect(isCI()).toBe(true)
    })

    it('returns true for any non-empty CI value (e.g. "1")', () => {
        vi.stubEnv('CI', '1')
        expect(isCI()).toBe(true)
    })

    it('returns false when CI is explicitly "false" (opt-out convention)', () => {
        vi.stubEnv('CI', 'false')
        expect(isCI()).toBe(false)
    })

    it('returns false when CI is the empty string', () => {
        vi.stubEnv('CI', '')
        expect(isCI()).toBe(false)
    })

    it('returns false when CI is unset', () => {
        vi.stubEnv('CI', undefined)
        expect(isCI()).toBe(false)
    })
})

// `isStdoutTTY` / `isStdinTTY` / `isStderrTTY` are pure pass-throughs to
// `process.<stream>.isTTY`; covering them here would only verify Node, not us.
