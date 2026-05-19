import { describe, expect, it, vi } from 'vitest'

import { findById, trySetSecret } from './internal.js'
import { type SecureStore, SecureStoreUnavailableError } from './secure-store.js'

type Account = { id: string; label?: string; email: string }

describe('findById', () => {
    const accountA: Account = { id: 'a', email: 'a@x' }
    const accountB: Account = { id: 'b', email: 'b@x' }

    it('returns the matching record when present', () => {
        const result = findById([{ account: accountA }, { account: accountB }], 'b')
        expect(result?.account).toBe(accountB)
    })

    it('returns undefined when no record matches', () => {
        const result = findById([{ account: accountA }], 'missing')
        expect(result).toBeUndefined()
    })

    it('returns undefined for an empty list', () => {
        expect(findById<Account>([], 'a')).toBeUndefined()
    })
})

describe('trySetSecret', () => {
    function fakeStore(setImpl: (secret: string) => Promise<void>): SecureStore {
        return {
            getSecret: vi.fn(async () => null),
            setSecret: setImpl,
            deleteSecret: vi.fn(async () => false),
        }
    }

    it('returns true on a successful setSecret', async () => {
        const store = fakeStore(async () => undefined)
        expect(await trySetSecret(store, 'tok')).toBe(true)
    })

    it('returns false on SecureStoreUnavailableError (the documented offline downgrade)', async () => {
        const store = fakeStore(async () => {
            throw new SecureStoreUnavailableError('no dbus')
        })
        expect(await trySetSecret(store, 'tok')).toBe(false)
    })

    it('rethrows non-SecureStoreUnavailable errors (no silent downgrade for programming bugs)', async () => {
        // Without this, an unexpected backend error would be
        // indistinguishable from "keyring offline", and callers would
        // silently fall through to the plaintext-fallback path on the
        // wrong signal. The narrow catch is load-bearing.
        const cause = new Error('something else went wrong')
        const store = fakeStore(async () => {
            throw cause
        })
        await expect(trySetSecret(store, 'tok')).rejects.toBe(cause)
    })
})
