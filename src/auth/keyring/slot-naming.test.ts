import { describe, expect, it } from 'vitest'

import { refreshAccountSlot } from './slot-naming.js'

describe('refreshAccountSlot', () => {
    it('appends the well-known suffix to the access slot name', () => {
        // Pinning the wire format here means a future rename has to update
        // exactly this test plus production code — no silent drift.
        expect(refreshAccountSlot('user-42')).toBe('user-42/refresh')
    })

    it('does not collapse an empty access slot to a bare suffix', () => {
        // Defensive: `endsWith(refreshAccountSlot(''))` is how the
        // test fixture routes between access and refresh slot mocks, so
        // the suffix must remain a non-empty, distinctive substring.
        const suffix = refreshAccountSlot('')
        expect(suffix.length).toBeGreaterThan(0)
        expect(suffix.startsWith('/')).toBe(true)
    })
})
