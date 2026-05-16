import { describe, expect, it } from 'vitest'

import { buildSingleSlot, buildUserRecords } from '../../test-support/keyring-mocks.js'
import { writeRecordWithKeyringFallback } from './record-write.js'
import { SecureStoreUnavailableError } from './secure-store.js'

type Account = { id: string; label?: string; email: string }

const account: Account = { id: '42', label: 'me', email: 'a@b.c' }

describe('writeRecordWithKeyringFallback', () => {
    it('writes to the keyring slot and upserts a record with no fallbackToken on the happy path', async () => {
        const secureStore = buildSingleSlot()
        const { store: userRecords, state, upsertSpy } = buildUserRecords<Account>()

        const result = await writeRecordWithKeyringFallback({
            secureStore,
            userRecords,
            account,
            token: '  tok_secret  ',
        })

        expect(result.storedSecurely).toBe(true)
        expect(secureStore.setSpy).toHaveBeenCalledWith('tok_secret')
        expect(upsertSpy).toHaveBeenCalledWith({ account })
        expect(state.records.get('42')?.fallbackToken).toBeUndefined()
    })

    it('falls back to fallbackToken on the user record when the keyring is offline', async () => {
        const secureStore = buildSingleSlot()
        secureStore.setSpy.mockRejectedValueOnce(new SecureStoreUnavailableError('no dbus'))
        const { store: userRecords, state } = buildUserRecords<Account>()

        const result = await writeRecordWithKeyringFallback({
            secureStore,
            userRecords,
            account,
            token: 'tok_plain',
        })

        expect(result.storedSecurely).toBe(false)
        expect(state.records.get('42')?.fallbackToken).toBe('tok_plain')
    })

    it('rethrows non-keyring errors from setSecret without writing the record', async () => {
        const secureStore = buildSingleSlot()
        const cause = new Error('unexpected backend explosion')
        secureStore.setSpy.mockRejectedValueOnce(cause)
        const { store: userRecords, state } = buildUserRecords<Account>()

        await expect(
            writeRecordWithKeyringFallback({
                secureStore,
                userRecords,
                account,
                token: 'tok',
            }),
        ).rejects.toBe(cause)
        expect(state.records.size).toBe(0)
    })

    it('rolls back the keyring write when upsert fails (no orphan credential)', async () => {
        const secureStore = buildSingleSlot()
        const { store: userRecords, upsertSpy } = buildUserRecords<Account>()
        upsertSpy.mockRejectedValueOnce(new Error('disk full'))

        await expect(
            writeRecordWithKeyringFallback({
                secureStore,
                userRecords,
                account,
                token: 'tok',
            }),
        ).rejects.toThrow('disk full')
        expect(secureStore.deleteSpy).toHaveBeenCalledTimes(1)
    })

    it('does not rollback the keyring on upsert failure when the write went to fallbackToken', async () => {
        // No successful keyring write happened, so there is nothing to roll
        // back. Verify the helper doesn't accidentally call deleteSecret
        // in this branch.
        const secureStore = buildSingleSlot()
        secureStore.setSpy.mockRejectedValueOnce(new SecureStoreUnavailableError('no dbus'))
        const { store: userRecords, upsertSpy } = buildUserRecords<Account>()
        upsertSpy.mockRejectedValueOnce(new Error('disk full'))

        await expect(
            writeRecordWithKeyringFallback({
                secureStore,
                userRecords,
                account,
                token: 'tok',
            }),
        ).rejects.toThrow('disk full')
        expect(secureStore.deleteSpy).not.toHaveBeenCalled()
    })
})
