import { describe, expect, it, vi } from 'vitest'

import type { AuthAccount } from '../types.js'
import { readRefreshTokenForRecord } from './internal.js'
import { type SecureStore, SecureStoreUnavailableError } from './secure-store.js'
import type { UserRecord } from './types.js'

type Account = AuthAccount & { id: string }
const account: Account = { id: '42' }

function fakeStore(impl: Partial<SecureStore>): SecureStore {
    return {
        async getSecret() {
            return null
        },
        async setSecret() {},
        async deleteSecret() {
            return false
        },
        ...impl,
    }
}

describe('readRefreshTokenForRecord', () => {
    it('short-circuits to not-present when hasRefreshToken is false', async () => {
        const getSpy = vi.fn(async () => 'should-not-be-read')
        const store = fakeStore({ getSecret: getSpy })
        const record: UserRecord<Account> = { account, hasRefreshToken: false }

        const outcome = await readRefreshTokenForRecord(record, store)
        expect(outcome).toEqual({ ok: false, reason: 'not-present' })
        expect(getSpy).not.toHaveBeenCalled()
    })

    it('returns fallbackRefreshToken in preference to a (possibly stale) keyring slot', async () => {
        const getSpy = vi.fn(async () => 'stale')
        const store = fakeStore({ getSecret: getSpy })
        const record: UserRecord<Account> = {
            account,
            hasRefreshToken: true,
            fallbackRefreshToken: 'plaintext_fallback',
        }

        const outcome = await readRefreshTokenForRecord(record, store)
        expect(outcome).toEqual({ ok: true, token: 'plaintext_fallback' })
        expect(getSpy).not.toHaveBeenCalled()
    })

    it('reads the keyring slot when no fallback is present', async () => {
        const store = fakeStore({
            async getSecret() {
                return 'from_keyring'
            },
        })
        const record: UserRecord<Account> = { account, hasRefreshToken: true }

        const outcome = await readRefreshTokenForRecord(record, store)
        expect(outcome).toEqual({ ok: true, token: 'from_keyring' })
    })

    it('maps SecureStoreUnavailableError to slot-unavailable', async () => {
        const store = fakeStore({
            async getSecret() {
                throw new SecureStoreUnavailableError('no dbus')
            },
        })
        const record: UserRecord<Account> = { account, hasRefreshToken: true }

        const outcome = await readRefreshTokenForRecord(record, store)
        expect(outcome).toMatchObject({ ok: false, reason: 'slot-unavailable' })
    })
})
