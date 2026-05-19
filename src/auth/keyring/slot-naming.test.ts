import { describe, expect, it } from 'vitest'

import { refreshAccountSlot } from './slot-naming.js'

describe('refreshAccountSlot', () => {
    it('pins the literal wire format `<accessSlot>/refresh`', () => {
        // The suffix is persisted state in the OS keyring: a rename
        // (e.g. `/refresh` → `:refresh`) would orphan every existing
        // user's refresh secret because their record would still point
        // at the old slot. Pin the exact format here so an unintended
        // change loudly breaks this test instead of silently breaking
        // upgraders. Intentional renames require a migration plan AND
        // updating this assertion.
        expect(refreshAccountSlot('user-42')).toBe('user-42/refresh')
    })

    it('is deterministic — same access slot maps to the same refresh slot', () => {
        // Critical for `clear()` to find the same slot it wrote to.
        expect(refreshAccountSlot('user-42')).toBe(refreshAccountSlot('user-42'))
    })

    it('different access slots map to different refresh slots', () => {
        // Critical for multi-account stores: account A's refresh secret
        // must not leak into account B's refresh slot.
        expect(refreshAccountSlot('user-1')).not.toBe(refreshAccountSlot('user-2'))
    })
})
