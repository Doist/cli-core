import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
    buildKeyringMap,
    buildSingleSlot,
    buildUserRecords,
} from '../../test-support/keyring-mocks.js'
import { SecureStoreUnavailableError } from './secure-store.js'
import { createKeyringTokenStore } from './token-store.js'

vi.mock('./secure-store.js', async () => {
    const actual = await vi.importActual<typeof import('./secure-store.js')>('./secure-store.js')
    return {
        ...actual,
        createSecureStore: vi.fn(),
    }
})

const { createSecureStore } = await import('./secure-store.js')
const mockedCreateSecureStore = vi.mocked(createSecureStore)

type Account = {
    id: string
    label?: string
    email: string
}

const SERVICE = 'cli-core-test'
const account: Account = { id: '42', label: 'me', email: 'a@b.c' }

describe('createKeyringTokenStore', () => {
    beforeEach(() => {
        mockedCreateSecureStore.mockReset()
    })

    it('round-trips set → active → clear when the keyring is online', async () => {
        const keyring = buildSingleSlot()
        mockedCreateSecureStore.mockReturnValue(keyring)
        const { store: userRecords, state, upsertSpy } = buildUserRecords<Account>()

        const store = createKeyringTokenStore<Account>({ serviceName: SERVICE, userRecords })

        await store.set(account, 'tok_secret')
        expect(keyring.setSpy).toHaveBeenCalledWith('tok_secret')
        expect(upsertSpy).toHaveBeenCalledWith({ id: '42', account })
        expect(state.defaultId).toBe('42')
        expect(store.getLastStorageResult()).toEqual({ storage: 'secure-store' })

        const active = await store.active()
        expect(active).toEqual({ token: 'tok_secret', account })

        await store.clear()
        expect(keyring.deleteSpy).toHaveBeenCalledTimes(1)
        expect(state.records.size).toBe(0)
        expect(state.defaultId).toBeNull()
        expect(store.getLastClearResult()).toEqual({ storage: 'secure-store' })
    })

    it('falls back to a plaintext token on the user record when the keyring is offline', async () => {
        const keyring = buildSingleSlot()
        keyring.setSpy.mockRejectedValueOnce(new SecureStoreUnavailableError('no dbus'))
        mockedCreateSecureStore.mockReturnValue(keyring)
        const { store: userRecords, state } = buildUserRecords<Account>()

        const store = createKeyringTokenStore<Account>({ serviceName: SERVICE, userRecords })

        await store.set(account, 'tok_plain')

        const record = state.records.get('42')
        expect(record?.fallbackToken).toBe('tok_plain')
        expect(store.getLastStorageResult()).toEqual({
            storage: 'config-file',
            warning:
                'system credential manager unavailable; token saved as plaintext in /tmp/fake/config.json',
        })

        const active = await store.active()
        expect(active).toEqual({ token: 'tok_plain', account })
        expect(keyring.getSpy).not.toHaveBeenCalled()
    })

    it('rolls back the keyring write when the user record upsert fails', async () => {
        const keyring = buildSingleSlot()
        mockedCreateSecureStore.mockReturnValue(keyring)
        const { store: userRecords, upsertSpy } = buildUserRecords<Account>()
        upsertSpy.mockRejectedValueOnce(new Error('disk full'))

        const store = createKeyringTokenStore<Account>({ serviceName: SERVICE, userRecords })

        await expect(store.set(account, 'tok')).rejects.toThrow('disk full')
        expect(keyring.setSpy).toHaveBeenCalledWith('tok')
        expect(keyring.deleteSpy).toHaveBeenCalledTimes(1)
    })

    it('set() still succeeds when the best-effort default promotion fails', async () => {
        const keyring = buildSingleSlot()
        mockedCreateSecureStore.mockReturnValue(keyring)
        const { store: userRecords, state, setDefaultSpy } = buildUserRecords<Account>()
        setDefaultSpy.mockRejectedValueOnce(new Error('default-write blew up'))

        const store = createKeyringTokenStore<Account>({ serviceName: SERVICE, userRecords })

        await expect(store.set(account, 'tok')).resolves.toBeUndefined()
        expect(state.records.get('42')?.account).toEqual(account)
        // Default never got set because the write failed, but the user record is durable.
        expect(state.defaultId).toBeNull()
    })

    it('throws AUTH_STORE_READ_FAILED when active() finds a record but the keyring is offline', async () => {
        const keyring = buildSingleSlot({ secret: 'tok' })
        keyring.getSpy.mockRejectedValueOnce(new SecureStoreUnavailableError('locked'))
        mockedCreateSecureStore.mockReturnValue(keyring)
        const { store: userRecords, state } = buildUserRecords<Account>()
        state.records.set('42', { id: '42', account })
        state.defaultId = '42'

        const store = createKeyringTokenStore<Account>({ serviceName: SERVICE, userRecords })

        await expect(store.active()).rejects.toMatchObject({ code: 'AUTH_STORE_READ_FAILED' })
    })

    it('picks the lone user when no default is set', async () => {
        const keyring = buildSingleSlot({ secret: 'tok' })
        mockedCreateSecureStore.mockReturnValue(keyring)
        const { store: userRecords, state } = buildUserRecords<Account>()
        state.records.set('42', { id: '42', account })

        const store = createKeyringTokenStore<Account>({ serviceName: SERVICE, userRecords })

        await expect(store.active()).resolves.toEqual({ token: 'tok', account })
    })

    it('returns null when multiple users exist and no default is set', async () => {
        const { store: userRecords, state } = buildUserRecords<Account>()
        state.records.set('1', { id: '1', account: { ...account, id: '1' } })
        state.records.set('2', { id: '2', account: { ...account, id: '2' } })

        const store = createKeyringTokenStore<Account>({ serviceName: SERVICE, userRecords })

        await expect(store.active()).resolves.toBeNull()
    })

    it('does not overwrite an existing default when a second user is added', async () => {
        const keyring = buildSingleSlot()
        mockedCreateSecureStore.mockReturnValue(keyring)
        const { store: userRecords, state } = buildUserRecords<Account>()
        state.defaultId = '1'
        state.records.set('1', { id: '1', account: { ...account, id: '1' } })

        const store = createKeyringTokenStore<Account>({ serviceName: SERVICE, userRecords })

        await store.set({ ...account, id: '2' }, 'tok_b')

        expect(state.defaultId).toBe('1')
    })

    it('clear() still calls the keyring delete when a fallbackToken is present (orphan cleanup)', async () => {
        const keyring = buildSingleSlot({ secret: 'orphan_from_earlier_write' })
        mockedCreateSecureStore.mockReturnValue(keyring)
        const { store: userRecords, state } = buildUserRecords<Account>()
        state.records.set('42', { id: '42', account, fallbackToken: 'tok_plain' })
        state.defaultId = '42'

        const store = createKeyringTokenStore<Account>({ serviceName: SERVICE, userRecords })

        await store.clear()

        expect(keyring.deleteSpy).toHaveBeenCalledTimes(1)
        expect(state.records.size).toBe(0)
        expect(store.getLastClearResult()).toEqual({
            storage: 'config-file',
            warning:
                'system credential manager unavailable; local auth state cleared in /tmp/fake/config.json',
        })
    })

    it('clear() downgrades to a warning when the keyring delete fails', async () => {
        const keyring = buildSingleSlot({ secret: 'tok' })
        keyring.deleteSpy.mockRejectedValueOnce(new SecureStoreUnavailableError('offline'))
        mockedCreateSecureStore.mockReturnValue(keyring)
        const { store: userRecords, state } = buildUserRecords<Account>()
        state.records.set('42', { id: '42', account })
        state.defaultId = '42'

        const store = createKeyringTokenStore<Account>({ serviceName: SERVICE, userRecords })

        await store.clear()

        expect(state.records.size).toBe(0)
        expect(store.getLastClearResult()).toMatchObject({ storage: 'config-file' })
    })

    it('clear() still deletes the keyring slot even when setDefaultId(null) throws', async () => {
        const keyring = buildSingleSlot({ secret: 'tok' })
        mockedCreateSecureStore.mockReturnValue(keyring)
        const { store: userRecords, state, setDefaultSpy } = buildUserRecords<Account>()
        state.records.set('42', { id: '42', account })
        state.defaultId = '42'
        setDefaultSpy.mockRejectedValueOnce(new Error('disk full'))

        const store = createKeyringTokenStore<Account>({ serviceName: SERVICE, userRecords })

        await store.clear()

        // Default pointer write blew up, but the keyring entry was still
        // cleaned up — otherwise the record's old credential would become
        // an unreachable orphan.
        expect(keyring.deleteSpy).toHaveBeenCalledTimes(1)
        expect(state.records.size).toBe(0)
    })

    it('uses a custom accountForUser slug when provided', async () => {
        const keyring = buildSingleSlot()
        mockedCreateSecureStore.mockReturnValue(keyring)
        const { store: userRecords } = buildUserRecords<Account>()

        const store = createKeyringTokenStore<Account>({
            serviceName: SERVICE,
            userRecords,
            accountForUser: (id) => `custom-${id}`,
        })

        await store.set(account, 'tok')

        expect(mockedCreateSecureStore).toHaveBeenCalledWith({
            serviceName: SERVICE,
            account: 'custom-42',
        })
    })

    describe('AccountRef support (keyed per-user slots)', () => {
        function buildMultiUser() {
            const km = buildKeyringMap()
            mockedCreateSecureStore.mockImplementation(km.create)
            const { store: userRecords, state, removeSpy } = buildUserRecords<Account>()
            state.records.set('1', { id: '1', account: { id: '1', label: 'alice', email: 'a@b' } })
            state.records.set('2', {
                id: '2',
                account: { id: '2', label: 'bob', email: 'c@d' },
                fallbackToken: 'tok_b',
            })
            km.slots.set('user-1', { secret: 'tok_a' })
            return { km, userRecords, state, removeSpy }
        }

        it('active(ref) reads from the matching per-user slot', async () => {
            const { km, userRecords } = buildMultiUser()
            const store = createKeyringTokenStore<Account>({ serviceName: SERVICE, userRecords })

            const snapshot = await store.active('1')
            expect(snapshot?.account.id).toBe('1')
            expect(snapshot?.token).toBe('tok_a')

            // Sanity check: matched user 1 only — user 2's keyring slot was
            // never touched (its record carries `fallbackToken`).
            expect(km.slots.has('user-2')).toBe(false)
        })

        it('active(ref) prefers the fallbackToken over a stale keyring entry', async () => {
            const { km, userRecords } = buildMultiUser()
            // Simulate an orphan keyring entry left from a prior online write.
            km.slots.set('user-2', { secret: 'tok_b_stale' })

            const store = createKeyringTokenStore<Account>({ serviceName: SERVICE, userRecords })

            const snapshot = await store.active('2')
            expect(snapshot?.token).toBe('tok_b')
        })

        it('active(ref) returns null on a miss (attacher translates to ACCOUNT_NOT_FOUND)', async () => {
            const { userRecords } = buildMultiUser()
            const store = createKeyringTokenStore<Account>({ serviceName: SERVICE, userRecords })

            await expect(store.active('does-not-exist')).resolves.toBeNull()
        })

        it('clear(ref) removes the matching record and deletes only its keyring slot', async () => {
            const { km, userRecords, state } = buildMultiUser()
            state.defaultId = '1'
            const store = createKeyringTokenStore<Account>({ serviceName: SERVICE, userRecords })

            await store.clear('1')

            expect(state.records.has('1')).toBe(false)
            expect(state.records.has('2')).toBe(true)
            expect(state.defaultId).toBeNull()
            // user-1's slot was cleared; user-2's slot was never touched.
            expect(km.slots.get('user-1')?.secret).toBeNull()
            expect((km.deleteCalls.get('user-1') ?? 0) > 0).toBe(true)
            expect(km.deleteCalls.has('user-2')).toBe(false)
        })

        it('honours a custom matchAccount predicate', async () => {
            const km = buildKeyringMap()
            mockedCreateSecureStore.mockImplementation(km.create)
            const { store: userRecords, state } = buildUserRecords<Account>()
            state.records.set('1', { id: '1', account: { id: '1', email: 'Alice@x.io' } })
            km.slots.set('user-1', { secret: 'tok' })

            const store = createKeyringTokenStore<Account>({
                serviceName: SERVICE,
                userRecords,
                matchAccount: (acc, ref) => acc.email.toLowerCase() === ref.toLowerCase(),
            })

            await expect(store.active('alice@x.io')).resolves.toMatchObject({
                account: { id: '1' },
            })
        })
    })

    describe('list() + setDefault()', () => {
        it('list() returns every account with the default marker', async () => {
            const { store: userRecords, state } = buildUserRecords<Account>()
            state.records.set('1', { id: '1', account: { id: '1', email: 'a@b' } })
            state.records.set('2', { id: '2', account: { id: '2', email: 'c@d' } })
            state.defaultId = '2'

            const store = createKeyringTokenStore<Account>({ serviceName: SERVICE, userRecords })

            const all = await store.list()
            expect(all).toHaveLength(2)
            expect(all.find((entry) => entry.account.id === '2')?.isDefault).toBe(true)
            expect(all.find((entry) => entry.account.id === '1')?.isDefault).toBe(false)
        })

        it('list() marks a single record as default even when no defaultId is pinned (matches active())', async () => {
            const { store: userRecords, state } = buildUserRecords<Account>()
            state.records.set('42', { id: '42', account })
            // No defaultId set — active() treats the lone record as the
            // implicit default, so list() must too.

            const store = createKeyringTokenStore<Account>({ serviceName: SERVICE, userRecords })

            const all = await store.list()
            expect(all).toEqual([{ account, isDefault: true }])
        })

        it('setDefault(ref) marks the matching account as default', async () => {
            const { store: userRecords, state } = buildUserRecords<Account>()
            state.records.set('1', { id: '1', account: { id: '1', label: 'a', email: 'a@b' } })
            state.records.set('2', { id: '2', account: { id: '2', label: 'b', email: 'c@d' } })
            state.defaultId = '1'

            const store = createKeyringTokenStore<Account>({ serviceName: SERVICE, userRecords })

            await store.setDefault('b')
            expect(state.defaultId).toBe('2')
            expect(mockedCreateSecureStore).not.toHaveBeenCalled()
        })

        it('setDefault(ref) throws ACCOUNT_NOT_FOUND on a miss', async () => {
            const { store: userRecords, state } = buildUserRecords<Account>()
            state.records.set('1', { id: '1', account })

            const store = createKeyringTokenStore<Account>({ serviceName: SERVICE, userRecords })

            await expect(store.setDefault('nope')).rejects.toMatchObject({
                code: 'ACCOUNT_NOT_FOUND',
            })
        })
    })
})
