import { describe, expect, it } from 'vitest'

import { refreshAccountSlot } from './slot-naming.js'

describe('refreshAccountSlot', () => {
    it('derives a per-access-slot refresh slot name that includes the access slot', () => {
        // The contract: the returned slot name is a function of the
        // access slot name AND uniquely identifies the refresh slot for
        // it. We don't pin the exact suffix here — the wire format is
        // free to change as long as the property holds.
        const result = refreshAccountSlot('user-42')
        expect(result).toContain('user-42')
        expect(result).not.toBe('user-42')
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
