import { beforeEach, describe, expect, it, vi } from 'vitest'

import { SecureStoreUnavailableError, type SecureStore } from './secure-store.js'
import { createKeyringTokenStore } from './token-store.js'
import type { UserRecord, UserRecordStore } from './types.js'

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

type Slot = {
    secret: string | null
    getErr?: unknown
    setErr?: unknown
    delErr?: unknown
}

function buildKeyringMap(): {
    create: (args: { serviceName: string; account: string }) => SecureStore
    slots: Map<string, Slot>
    deleteCalls: Map<string, number>
} {
    const slots = new Map<string, Slot>()
    const deleteCalls = new Map<string, number>()
    function getSlot(account: string): Slot {
        let slot = slots.get(account)
        if (!slot) {
            slot = { secret: null }
            slots.set(account, slot)
        }
        return slot
    }
    return {
        slots,
        deleteCalls,
        create({ account }) {
            return {
                async getSecret() {
                    const slot = getSlot(account)
                    if (slot.getErr) throw slot.getErr
                    return slot.secret
                },
                async setSecret(secret) {
                    const slot = getSlot(account)
                    if (slot.setErr) throw slot.setErr
                    slot.secret = secret
                },
                async deleteSecret() {
                    deleteCalls.set(account, (deleteCalls.get(account) ?? 0) + 1)
                    const slot = getSlot(account)
                    if (slot.delErr) throw slot.delErr
                    const had = slot.secret !== null
                    slot.secret = null
                    return had
                },
            }
        },
    }
}

function buildSingleSlot(initial: { secret?: string | null } = {}): SecureStore & {
    getSpy: ReturnType<typeof vi.fn>
    setSpy: ReturnType<typeof vi.fn>
    deleteSpy: ReturnType<typeof vi.fn>
} {
    const state = { secret: initial.secret ?? null }
    const getSpy = vi.fn(async () => state.secret)
    const setSpy = vi.fn(async (secret: string) => {
        state.secret = secret
    })
    const deleteSpy = vi.fn(async () => {
        const had = state.secret !== null
        state.secret = null
        return had
    })
    return {
        getSpy,
        setSpy,
        deleteSpy,
        async getSecret() {
            return getSpy()
        },
        async setSecret(secret: string) {
            return setSpy(secret)
        },
        async deleteSecret() {
            return deleteSpy()
        },
    }
}

function buildUserRecords(): {
    store: UserRecordStore<Account>
    state: {
        records: Map<string, UserRecord<Account>>
        defaultId: string | null
    }
    upsertSpy: ReturnType<typeof vi.fn>
    removeSpy: ReturnType<typeof vi.fn>
    setDefaultSpy: ReturnType<typeof vi.fn>
} {
    const state = {
        records: new Map<string, UserRecord<Account>>(),
        defaultId: null as string | null,
    }
    const upsertSpy = vi.fn(async (record: UserRecord<Account>) => {
        state.records.set(record.id, record)
    })
    const removeSpy = vi.fn(async (id: string) => {
        state.records.delete(id)
    })
    const setDefaultSpy = vi.fn(async (id: string | null) => {
        state.defaultId = id
    })
    const store: UserRecordStore<Account> = {
        async list() {
            return [...state.records.values()]
        },
        async getById(id) {
            return state.records.get(id) ?? null
        },
        upsert: upsertSpy,
        remove: removeSpy,
        async getDefaultId() {
            return state.defaultId
        },
        setDefaultId: setDefaultSpy,
        describeLocation() {
            return '/tmp/fake/config.json'
        },
    }
    return { store, state, upsertSpy, removeSpy, setDefaultSpy }
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
        const { store: userRecords, state, upsertSpy } = buildUserRecords()

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
        const { store: userRecords, state } = buildUserRecords()

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
        const { store: userRecords, upsertSpy } = buildUserRecords()
        upsertSpy.mockRejectedValueOnce(new Error('disk full'))

        const store = createKeyringTokenStore<Account>({ serviceName: SERVICE, userRecords })

        await expect(store.set(account, 'tok')).rejects.toThrow('disk full')
        expect(keyring.setSpy).toHaveBeenCalledWith('tok')
        expect(keyring.deleteSpy).toHaveBeenCalledTimes(1)
    })

    it('set() still succeeds when the best-effort default promotion fails', async () => {
        const keyring = buildSingleSlot()
        mockedCreateSecureStore.mockReturnValue(keyring)
        const { store: userRecords, state, setDefaultSpy } = buildUserRecords()
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
        const { store: userRecords, state } = buildUserRecords()
        state.records.set('42', { id: '42', account })
        state.defaultId = '42'

        const store = createKeyringTokenStore<Account>({ serviceName: SERVICE, userRecords })

        await expect(store.active()).rejects.toMatchObject({ code: 'AUTH_STORE_READ_FAILED' })
    })

    it('returns null from active() when no records exist', async () => {
        mockedCreateSecureStore.mockReturnValue(buildSingleSlot())
        const { store: userRecords } = buildUserRecords()

        const store = createKeyringTokenStore<Account>({ serviceName: SERVICE, userRecords })

        await expect(store.active()).resolves.toBeNull()
    })

    it('picks the lone user when no default is set', async () => {
        const keyring = buildSingleSlot({ secret: 'tok' })
        mockedCreateSecureStore.mockReturnValue(keyring)
        const { store: userRecords, state } = buildUserRecords()
        state.records.set('42', { id: '42', account })

        const store = createKeyringTokenStore<Account>({ serviceName: SERVICE, userRecords })

        await expect(store.active()).resolves.toEqual({ token: 'tok', account })
    })

    it('returns null when multiple users exist and no default is set', async () => {
        mockedCreateSecureStore.mockReturnValue(buildSingleSlot())
        const { store: userRecords, state } = buildUserRecords()
        state.records.set('1', { id: '1', account: { ...account, id: '1' } })
        state.records.set('2', { id: '2', account: { ...account, id: '2' } })

        const store = createKeyringTokenStore<Account>({ serviceName: SERVICE, userRecords })

        await expect(store.active()).resolves.toBeNull()
    })

    it('does not overwrite an existing default when a second user is added', async () => {
        const keyring = buildSingleSlot()
        mockedCreateSecureStore.mockReturnValue(keyring)
        const { store: userRecords, state } = buildUserRecords()
        state.defaultId = '1'
        state.records.set('1', { id: '1', account: { ...account, id: '1' } })

        const store = createKeyringTokenStore<Account>({ serviceName: SERVICE, userRecords })

        await store.set({ ...account, id: '2' }, 'tok_b')

        expect(state.defaultId).toBe('1')
    })

    it('clear() is a no-op when no record exists', async () => {
        mockedCreateSecureStore.mockReturnValue(buildSingleSlot())
        const { store: userRecords } = buildUserRecords()

        const store = createKeyringTokenStore<Account>({ serviceName: SERVICE, userRecords })

        await expect(store.clear()).resolves.toBeUndefined()
        expect(store.getLastClearResult()).toBeUndefined()
    })

    it('clear() still calls the keyring delete when a fallbackToken is present (orphan cleanup)', async () => {
        const keyring = buildSingleSlot({ secret: 'orphan_from_earlier_write' })
        mockedCreateSecureStore.mockReturnValue(keyring)
        const { store: userRecords, state } = buildUserRecords()
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
        const { store: userRecords, state } = buildUserRecords()
        state.records.set('42', { id: '42', account })
        state.defaultId = '42'

        const store = createKeyringTokenStore<Account>({ serviceName: SERVICE, userRecords })

        await store.clear()

        expect(state.records.size).toBe(0)
        expect(store.getLastClearResult()).toMatchObject({ storage: 'config-file' })
    })

    it('uses a custom accountForUser slug when provided', async () => {
        const keyring = buildSingleSlot()
        mockedCreateSecureStore.mockReturnValue(keyring)
        const { store: userRecords } = buildUserRecords()

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
            const { store: userRecords, state, removeSpy } = buildUserRecords()
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

        it('active(ref) matches on label', async () => {
            const { userRecords } = buildMultiUser()
            const store = createKeyringTokenStore<Account>({ serviceName: SERVICE, userRecords })

            const snapshot = await store.active('alice')
            expect(snapshot?.account.id).toBe('1')
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
            expect(km.deleteCalls.get('user-1') ?? 0).toBeGreaterThan(0)
            expect(km.deleteCalls.has('user-2')).toBe(false)
        })

        it('clear(ref) on a miss is a no-op (attacher rejects via active() pre-check)', async () => {
            const { userRecords, state } = buildMultiUser()
            const store = createKeyringTokenStore<Account>({ serviceName: SERVICE, userRecords })

            await store.clear('nope')
            expect(state.records.has('1')).toBe(true)
            expect(state.records.has('2')).toBe(true)
        })

        it('honours a custom matchAccount predicate', async () => {
            const km = buildKeyringMap()
            mockedCreateSecureStore.mockImplementation(km.create)
            const { store: userRecords, state } = buildUserRecords()
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
            mockedCreateSecureStore.mockReturnValue(buildSingleSlot())
            const { store: userRecords, state } = buildUserRecords()
            state.records.set('1', { id: '1', account: { id: '1', email: 'a@b' } })
            state.records.set('2', { id: '2', account: { id: '2', email: 'c@d' } })
            state.defaultId = '2'

            const store = createKeyringTokenStore<Account>({ serviceName: SERVICE, userRecords })

            const all = await store.list()
            expect(all).toHaveLength(2)
            expect(all.find((entry) => entry.account.id === '2')?.isDefault).toBe(true)
            expect(all.find((entry) => entry.account.id === '1')?.isDefault).toBe(false)
        })

        it('list() returns an empty array when nothing is stored', async () => {
            mockedCreateSecureStore.mockReturnValue(buildSingleSlot())
            const { store: userRecords } = buildUserRecords()

            const store = createKeyringTokenStore<Account>({ serviceName: SERVICE, userRecords })

            await expect(store.list()).resolves.toEqual([])
        })

        it('setDefault(ref) marks the matching account as default', async () => {
            mockedCreateSecureStore.mockReturnValue(buildSingleSlot())
            const { store: userRecords, state } = buildUserRecords()
            state.records.set('1', { id: '1', account: { id: '1', label: 'a', email: 'a@b' } })
            state.records.set('2', { id: '2', account: { id: '2', label: 'b', email: 'c@d' } })
            state.defaultId = '1'

            const store = createKeyringTokenStore<Account>({ serviceName: SERVICE, userRecords })

            await store.setDefault('b')
            expect(state.defaultId).toBe('2')
        })

        it('setDefault(ref) throws ACCOUNT_NOT_FOUND on a miss', async () => {
            mockedCreateSecureStore.mockReturnValue(buildSingleSlot())
            const { store: userRecords, state } = buildUserRecords()
            state.records.set('1', { id: '1', account })

            const store = createKeyringTokenStore<Account>({ serviceName: SERVICE, userRecords })

            await expect(store.setDefault('nope')).rejects.toMatchObject({
                code: 'ACCOUNT_NOT_FOUND',
            })
        })
    })
})
