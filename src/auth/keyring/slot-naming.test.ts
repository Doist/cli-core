import { describe, expect, it } from 'vitest'

import { refreshAccountSlot } from './slot-naming.js'

describe('refreshAccountSlot', () => {
    it('derives the refresh slot suffix from the access slot slug', () => {
        expect(refreshAccountSlot('user-42')).toBe('user-42/refresh')
    })
})
