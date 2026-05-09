import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'

import {
    DEFAULT_VERIFIER_ALPHABET,
    deriveChallenge,
    generateState,
    generateVerifier,
} from './pkce.js'

describe('generateVerifier', () => {
    it('defaults to 64 characters from the default alphabet', () => {
        const v = generateVerifier()
        expect(v.length).toBe(64)
        for (const ch of v) expect(DEFAULT_VERIFIER_ALPHABET.includes(ch)).toBe(true)
    })

    it('honours a custom length', () => {
        expect(generateVerifier({ length: 43 }).length).toBe(43)
        expect(generateVerifier({ length: 128 }).length).toBe(128)
    })

    it('honours a custom alphabet', () => {
        const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
        const v = generateVerifier({ alphabet, length: 100 })
        for (const ch of v) expect(alphabet.includes(ch)).toBe(true)
    })

    it('rejects lengths outside RFC 7636 bounds', () => {
        expect(() => generateVerifier({ length: 42 })).toThrow(RangeError)
        expect(() => generateVerifier({ length: 129 })).toThrow(RangeError)
    })

    it('rejects empty alphabet', () => {
        expect(() => generateVerifier({ alphabet: '' })).toThrow(RangeError)
    })

    it('produces high-entropy output (no two of 50 verifiers collide)', () => {
        const seen = new Set<string>()
        for (let i = 0; i < 50; i++) seen.add(generateVerifier())
        expect(seen.size).toBe(50)
    })
})

describe('deriveChallenge', () => {
    it('matches base64url(sha256(verifier))', () => {
        const verifier = 'M25iVXpKU3puUjFaYWg3T1NDTDQtcW1ROUY5YXlwalNoc0hhakxifmZHag'
        const expected = createHash('sha256').update(verifier).digest('base64url')
        expect(deriveChallenge(verifier)).toBe(expected)
    })

    it('produces URL-safe output (no `+`, `/`, or `=`)', () => {
        for (let i = 0; i < 20; i++) {
            const challenge = deriveChallenge(generateVerifier())
            expect(/[+/=]/.test(challenge)).toBe(false)
        }
    })
})

describe('generateState', () => {
    it('returns 32 hex characters (16 random bytes)', () => {
        const s = generateState()
        expect(s).toMatch(/^[0-9a-f]{32}$/)
    })

    it('produces unique values across calls', () => {
        const seen = new Set<string>()
        for (let i = 0; i < 50; i++) seen.add(generateState())
        expect(seen.size).toBe(50)
    })
})
