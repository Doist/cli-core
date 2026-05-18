import { describe, expect, it } from 'vitest'

import { buildSingleSlot, buildUserRecords } from '../../test-support/keyring-mocks.js'
import { writeRecordWithKeyringFallback } from './record-write.js'
import { SecureStoreUnavailableError } from './secure-store.js'

type Account = { id: string; label?: string; email: string }

const account: Account = { id: '42', label: 'me', email: 'a@b.c' }

describe('writeRecordWithKeyringFallback', () => {
    it('writes to the keyring slot and upserts a record with no fallbackToken on the happy path', async () => {
        const secureStore = buildSingleSlot()
        const refreshSecureStore = buildSingleSlot()
        const { store: userRecords, state, upsertSpy } = buildUserRecords<Account>()

        const result = await writeRecordWithKeyringFallback({
            secureStore,
            refreshSecureStore,
            userRecords,
            account,
            bundle: { accessToken: '  tok_secret  ' },
        })

        expect(result.storedSecurely).toBe(true)
        expect(secureStore.setSpy).toHaveBeenCalledWith('tok_secret')
        // No refresh token in bundle → defensive delete of the refresh slot.
        expect(refreshSecureStore.deleteSpy).toHaveBeenCalled()
        expect(upsertSpy).toHaveBeenCalledWith({
            account,
            accessTokenExpiresAt: undefined,
            refreshTokenExpiresAt: undefined,
            hasRefreshToken: false,
        })
        expect(state.records.get('42')?.fallbackToken).toBeUndefined()
        expect(state.records.get('42')?.fallbackRefreshToken).toBeUndefined()
    })

    it('writes both access and refresh secrets when bundle includes refresh token', async () => {
        const secureStore = buildSingleSlot()
        const refreshSecureStore = buildSingleSlot()
        const { store: userRecords, state } = buildUserRecords<Account>()

        const result = await writeRecordWithKeyringFallback({
            secureStore,
            refreshSecureStore,
            userRecords,
            account,
            bundle: {
                accessToken: 'access_tok',
                refreshToken: 'refresh_tok',
                accessTokenExpiresAt: 1_700_000_000_000,
            },
        })

        expect(result.storedSecurely).toBe(true)
        expect(secureStore.setSpy).toHaveBeenCalledWith('access_tok')
        expect(refreshSecureStore.setSpy).toHaveBeenCalledWith('refresh_tok')
        expect(state.records.get('42')?.accessTokenExpiresAt).toBe(1_700_000_000_000)
        expect(state.records.get('42')?.fallbackToken).toBeUndefined()
        expect(state.records.get('42')?.fallbackRefreshToken).toBeUndefined()
    })

    it('falls back to fallback tokens on the user record when the keyring is offline', async () => {
        const secureStore = buildSingleSlot()
        secureStore.setSpy.mockRejectedValueOnce(new SecureStoreUnavailableError('no dbus'))
        const refreshSecureStore = buildSingleSlot()
        const { store: userRecords, state } = buildUserRecords<Account>()

        const result = await writeRecordWithKeyringFallback({
            secureStore,
            refreshSecureStore,
            userRecords,
            account,
            bundle: { accessToken: 'tok_plain', refreshToken: 'refr_plain' },
        })

        expect(result.storedSecurely).toBe(false)
        expect(state.records.get('42')?.fallbackToken).toBe('tok_plain')
        expect(state.records.get('42')?.fallbackRefreshToken).toBe('refr_plain')
    })

    it('rolls back the access slot and parks both tokens on the record when the refresh slot is offline (partial-offline)', async () => {
        // Access slot writes successfully but the refresh slot is
        // unavailable — must NOT leave the access secret stranded in the
        // keyring while the refresh sits in the plaintext fallback. Both
        // travel together to the fallback record so `active()` always reads
        // from one consistent place.
        const secureStore = buildSingleSlot()
        const refreshSecureStore = buildSingleSlot()
        refreshSecureStore.setSpy.mockRejectedValueOnce(
            new SecureStoreUnavailableError('refresh slot down'),
        )
        const { store: userRecords, state } = buildUserRecords<Account>()

        const result = await writeRecordWithKeyringFallback({
            secureStore,
            refreshSecureStore,
            userRecords,
            account,
            bundle: { accessToken: 'at_split', refreshToken: 'rt_split' },
        })

        expect(result.storedSecurely).toBe(false)
        // Access slot was rolled back so the secret doesn't outlive the
        // fallback record.
        expect(secureStore.deleteSpy).toHaveBeenCalledTimes(1)
        expect(state.records.get('42')?.fallbackToken).toBe('at_split')
        expect(state.records.get('42')?.fallbackRefreshToken).toBe('rt_split')
        expect(state.records.get('42')?.hasRefreshToken).toBe(true)
    })

    it('rolls back the access slot and rethrows when refresh-slot setSecret throws a non-keyring error', async () => {
        // Otherwise we leave an orphan access credential with no matching
        // user record — `active()` later sees the orphan and the user can't
        // recover without manually clearing the keyring.
        const secureStore = buildSingleSlot()
        const refreshSecureStore = buildSingleSlot()
        const cause = new Error('refresh slot exploded')
        refreshSecureStore.setSpy.mockRejectedValueOnce(cause)
        const { store: userRecords, state } = buildUserRecords<Account>()

        await expect(
            writeRecordWithKeyringFallback({
                secureStore,
                refreshSecureStore,
                userRecords,
                account,
                bundle: { accessToken: 'at', refreshToken: 'rt' },
            }),
        ).rejects.toBe(cause)
        expect(secureStore.deleteSpy).toHaveBeenCalledTimes(1)
        expect(state.records.size).toBe(0)
    })

    it('treats a refresh-slot delete failure on a no-refresh bundle as a write failure (no resurrection)', async () => {
        // Without this rollback, a stale refresh secret from an earlier
        // login would survive a re-login that didn't return one, and
        // `active()` would later surface it. Belt-and-braces: roll back
        // access too so the on-disk and in-keyring state stay aligned.
        const secureStore = buildSingleSlot()
        const refreshSecureStore = buildSingleSlot()
        refreshSecureStore.deleteSpy.mockRejectedValueOnce(
            new SecureStoreUnavailableError('cannot reach refresh slot'),
        )
        const { store: userRecords, state } = buildUserRecords<Account>()

        const result = await writeRecordWithKeyringFallback({
            secureStore,
            refreshSecureStore,
            userRecords,
            account,
            bundle: { accessToken: 'at_only' },
        })

        // Fell through to fallback because the refresh-slot delete failed.
        expect(result.storedSecurely).toBe(false)
        expect(secureStore.deleteSpy).toHaveBeenCalledTimes(1)
        expect(state.records.get('42')?.fallbackToken).toBe('at_only')
        expect(state.records.get('42')?.hasRefreshToken).toBe(false)
    })

    it('rethrows non-keyring errors from setSecret without writing the record', async () => {
        const secureStore = buildSingleSlot()
        const cause = new Error('unexpected backend explosion')
        secureStore.setSpy.mockRejectedValueOnce(cause)
        const refreshSecureStore = buildSingleSlot()
        const { store: userRecords, state } = buildUserRecords<Account>()

        await expect(
            writeRecordWithKeyringFallback({
                secureStore,
                refreshSecureStore,
                userRecords,
                account,
                bundle: { accessToken: 'tok' },
            }),
        ).rejects.toBe(cause)
        expect(state.records.size).toBe(0)
    })

    it('rolls back the keyring write when upsert fails (no orphan credential)', async () => {
        const secureStore = buildSingleSlot()
        const refreshSecureStore = buildSingleSlot()
        const { store: userRecords, upsertSpy } = buildUserRecords<Account>()
        upsertSpy.mockRejectedValueOnce(new Error('disk full'))

        await expect(
            writeRecordWithKeyringFallback({
                secureStore,
                refreshSecureStore,
                userRecords,
                account,
                bundle: { accessToken: 'tok', refreshToken: 'refr' },
            }),
        ).rejects.toThrow('disk full')
        expect(secureStore.deleteSpy).toHaveBeenCalledTimes(1)
        expect(refreshSecureStore.deleteSpy).toHaveBeenCalledTimes(1)
    })

    it('does not rollback the keyring on upsert failure when the write went to fallbackToken', async () => {
        const secureStore = buildSingleSlot()
        secureStore.setSpy.mockRejectedValueOnce(new SecureStoreUnavailableError('no dbus'))
        const refreshSecureStore = buildSingleSlot()
        const { store: userRecords, upsertSpy } = buildUserRecords<Account>()
        upsertSpy.mockRejectedValueOnce(new Error('disk full'))

        await expect(
            writeRecordWithKeyringFallback({
                secureStore,
                refreshSecureStore,
                userRecords,
                account,
                bundle: { accessToken: 'tok' },
            }),
        ).rejects.toThrow('disk full')
        expect(secureStore.deleteSpy).not.toHaveBeenCalled()
        expect(refreshSecureStore.deleteSpy).not.toHaveBeenCalled()
    })
})
