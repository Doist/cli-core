import { describe, expect, it } from 'vitest'

import { buildSingleSlot, buildUserRecords } from '../../test-support/keyring-mocks.js'
import type { TokenBundle } from '../types.js'
import { writeBundleWithKeyringFallback, writeRecordWithKeyringFallback } from './record-write.js'
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
        expect(upsertSpy).toHaveBeenCalledWith({ account, hasRefreshToken: false })
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

describe('writeBundleWithKeyringFallback', () => {
    const bundle: TokenBundle = {
        accessToken: 'tok_a',
        refreshToken: 'tok_r',
        accessTokenExpiresAt: 1_700_000_000_000,
        refreshTokenExpiresAt: 1_701_000_000_000,
    }

    function harness() {
        const accessStore = buildSingleSlot()
        const refreshStore = buildSingleSlot()
        const records = buildUserRecords<Account>()
        return { accessStore, refreshStore, ...records }
    }

    it('writes both slots and persists the bundle metadata on the happy path', async () => {
        const { accessStore, refreshStore, store: userRecords, state, upsertSpy } = harness()

        const result = await writeBundleWithKeyringFallback({
            accessStore,
            refreshStore,
            userRecords,
            account,
            bundle,
        })

        expect(result).toEqual({ accessStoredSecurely: true, refreshStoredSecurely: true })
        expect(accessStore.setSpy).toHaveBeenCalledWith('tok_a')
        expect(refreshStore.setSpy).toHaveBeenCalledWith('tok_r')
        expect(upsertSpy).toHaveBeenCalledWith({
            account,
            accessTokenExpiresAt: 1_700_000_000_000,
            refreshTokenExpiresAt: 1_701_000_000_000,
            hasRefreshToken: true,
        })
        expect(state.records.get('42')?.fallbackToken).toBeUndefined()
        expect(state.records.get('42')?.fallbackRefreshToken).toBeUndefined()
    })

    it('clears the refresh slot when the bundle has no refresh token (no stale carryover)', async () => {
        const { accessStore, refreshStore, store: userRecords, state } = harness()

        await writeBundleWithKeyringFallback({
            accessStore,
            refreshStore,
            userRecords,
            account,
            bundle: { accessToken: 'tok_a' },
        })

        expect(refreshStore.deleteSpy).toHaveBeenCalledTimes(1)
        expect(state.records.get('42')?.hasRefreshToken).toBe(false)
    })

    it('falls back to fallbackRefreshToken when the refresh slot is offline', async () => {
        const { accessStore, refreshStore, store: userRecords, state } = harness()
        refreshStore.setSpy.mockRejectedValueOnce(new SecureStoreUnavailableError('no dbus'))

        const result = await writeBundleWithKeyringFallback({
            accessStore,
            refreshStore,
            userRecords,
            account,
            bundle,
        })

        expect(result).toEqual({ accessStoredSecurely: true, refreshStoredSecurely: false })
        expect(state.records.get('42')?.fallbackRefreshToken).toBe('tok_r')
        expect(state.records.get('42')?.fallbackToken).toBeUndefined()
    })

    it('rolls back the access slot when a non-keyring refresh-slot setSecret error fires', async () => {
        // Refresh-slot setSecret throws an unexpected error (not
        // SecureStoreUnavailable) — leaving the access slot written would
        // orphan a credential against a never-persisted record.
        const { accessStore, refreshStore, store: userRecords, state } = harness()
        refreshStore.setSpy.mockRejectedValueOnce(new Error('refresh slot blew up'))

        await expect(
            writeBundleWithKeyringFallback({
                accessStore,
                refreshStore,
                userRecords,
                account,
                bundle,
            }),
        ).rejects.toThrow('refresh slot blew up')

        expect(accessStore.deleteSpy).toHaveBeenCalledTimes(1)
        expect(state.records.size).toBe(0)
    })

    it('rolls back BOTH keyring slots when upsert fails after both writes succeeded', async () => {
        const { accessStore, refreshStore, store: userRecords, upsertSpy } = harness()
        upsertSpy.mockRejectedValueOnce(new Error('disk full'))

        await expect(
            writeBundleWithKeyringFallback({
                accessStore,
                refreshStore,
                userRecords,
                account,
                bundle,
            }),
        ).rejects.toThrow('disk full')

        expect(accessStore.deleteSpy).toHaveBeenCalledTimes(1)
        expect(refreshStore.deleteSpy).toHaveBeenCalledTimes(1)
    })

    it('falls back to fallbackToken when the access slot is offline (headless/WSL bundle path)', async () => {
        // Real-world headless / WSL / locked-Keychain scenario: D-Bus is
        // unavailable, so BOTH slot writes throw SecureStoreUnavailable.
        // The record must persist both tokens as plaintext fallbacks.
        const { accessStore, refreshStore, store: userRecords, state } = harness()
        accessStore.setSpy.mockRejectedValueOnce(new SecureStoreUnavailableError('no dbus'))
        refreshStore.setSpy.mockRejectedValueOnce(new SecureStoreUnavailableError('no dbus'))

        const result = await writeBundleWithKeyringFallback({
            accessStore,
            refreshStore,
            userRecords,
            account,
            bundle,
        })

        expect(result).toEqual({ accessStoredSecurely: false, refreshStoredSecurely: false })
        expect(state.records.get('42')?.fallbackToken).toBe('tok_a')
        expect(state.records.get('42')?.fallbackRefreshToken).toBe('tok_r')
        expect(state.records.get('42')?.hasRefreshToken).toBe(true)
    })

    it('defers the no-refresh slot wipe until after upsert succeeds', async () => {
        // Regression: wiping before upsert would lose refresh state if the
        // upsert then rejected. Order must be set-access → upsert → wipe.
        const { accessStore, refreshStore, store: userRecords, upsertSpy } = harness()
        const callOrder: string[] = []
        refreshStore.deleteSpy.mockImplementationOnce(async () => {
            callOrder.push('refresh-delete')
            return false
        })
        upsertSpy.mockImplementationOnce(async () => {
            callOrder.push('upsert')
        })

        await writeBundleWithKeyringFallback({
            accessStore,
            refreshStore,
            userRecords,
            account,
            bundle: { accessToken: 'tok_a' },
        })

        expect(callOrder).toEqual(['upsert', 'refresh-delete'])
    })
})
