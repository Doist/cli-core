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

function buildSecureStoreMock(initial: { secret?: string | null } = {}): SecureStore & {
    _state: { secret: string | null }
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
        _state: state,
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
        async setDefaultId(id) {
            state.defaultId = id
        },
        describeLocation() {
            return '/tmp/fake/config.json'
        },
    }
    return { store, state, upsertSpy, removeSpy }
}

const SERVICE = 'cli-core-test'
const account: Account = { id: '42', label: 'me', email: 'a@b.c' }

describe('createKeyringTokenStore', () => {
    beforeEach(() => {
        mockedCreateSecureStore.mockReset()
    })

    it('round-trips set → active → clear when the keyring is online', async () => {
        const keyring = buildSecureStoreMock()
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
        const keyring = buildSecureStoreMock()
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
        const keyring = buildSecureStoreMock()
        mockedCreateSecureStore.mockReturnValue(keyring)
        const { store: userRecords, upsertSpy } = buildUserRecords()
        upsertSpy.mockRejectedValueOnce(new Error('disk full'))

        const store = createKeyringTokenStore<Account>({ serviceName: SERVICE, userRecords })

        await expect(store.set(account, 'tok')).rejects.toThrow('disk full')
        expect(keyring.setSpy).toHaveBeenCalledWith('tok')
        expect(keyring.deleteSpy).toHaveBeenCalledTimes(1)
    })

    it('returns null from active() when the keyring is unreachable mid-session', async () => {
        const keyring = buildSecureStoreMock({ secret: 'tok' })
        keyring.getSpy.mockRejectedValueOnce(new SecureStoreUnavailableError('locked'))
        mockedCreateSecureStore.mockReturnValue(keyring)
        const { store: userRecords, state } = buildUserRecords()
        state.records.set('42', { id: '42', account })
        state.defaultId = '42'

        const store = createKeyringTokenStore<Account>({ serviceName: SERVICE, userRecords })

        await expect(store.active()).resolves.toBeNull()
    })

    it('returns null from active() when no records exist', async () => {
        mockedCreateSecureStore.mockReturnValue(buildSecureStoreMock())
        const { store: userRecords } = buildUserRecords()

        const store = createKeyringTokenStore<Account>({ serviceName: SERVICE, userRecords })

        await expect(store.active()).resolves.toBeNull()
    })

    it('picks the lone user when no default is set', async () => {
        const keyring = buildSecureStoreMock({ secret: 'tok' })
        mockedCreateSecureStore.mockReturnValue(keyring)
        const { store: userRecords, state } = buildUserRecords()
        state.records.set('42', { id: '42', account })

        const store = createKeyringTokenStore<Account>({ serviceName: SERVICE, userRecords })

        await expect(store.active()).resolves.toEqual({ token: 'tok', account })
    })

    it('returns null when multiple users exist and no default is set', async () => {
        mockedCreateSecureStore.mockReturnValue(buildSecureStoreMock())
        const { store: userRecords, state } = buildUserRecords()
        state.records.set('1', { id: '1', account: { ...account, id: '1' } })
        state.records.set('2', { id: '2', account: { ...account, id: '2' } })

        const store = createKeyringTokenStore<Account>({ serviceName: SERVICE, userRecords })

        await expect(store.active()).resolves.toBeNull()
    })

    it('does not overwrite an existing default when a second user is added', async () => {
        const keyring = buildSecureStoreMock()
        mockedCreateSecureStore.mockReturnValue(keyring)
        const { store: userRecords, state } = buildUserRecords()
        state.defaultId = '1'
        state.records.set('1', { id: '1', account: { ...account, id: '1' } })

        const store = createKeyringTokenStore<Account>({ serviceName: SERVICE, userRecords })

        await store.set({ ...account, id: '2' }, 'tok_b')

        expect(state.defaultId).toBe('1')
    })

    it('clear() is a no-op when no record exists', async () => {
        mockedCreateSecureStore.mockReturnValue(buildSecureStoreMock())
        const { store: userRecords } = buildUserRecords()

        const store = createKeyringTokenStore<Account>({ serviceName: SERVICE, userRecords })

        await expect(store.clear()).resolves.toBeUndefined()
        expect(store.getLastClearResult()).toBeUndefined()
    })

    it('clear() with a fallback-token record skips the keyring delete', async () => {
        const keyring = buildSecureStoreMock()
        mockedCreateSecureStore.mockReturnValue(keyring)
        const { store: userRecords, state } = buildUserRecords()
        state.records.set('42', { id: '42', account, fallbackToken: 'tok_plain' })
        state.defaultId = '42'

        const store = createKeyringTokenStore<Account>({ serviceName: SERVICE, userRecords })

        await store.clear()

        expect(keyring.deleteSpy).not.toHaveBeenCalled()
        expect(state.records.size).toBe(0)
        expect(store.getLastClearResult()).toEqual({
            storage: 'config-file',
            warning:
                'system credential manager unavailable; local auth state cleared in /tmp/fake/config.json',
        })
    })

    it('clear() downgrades to a warning when the keyring delete fails', async () => {
        const keyring = buildSecureStoreMock({ secret: 'tok' })
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
        const keyring = buildSecureStoreMock()
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

    describe('AccountRef support', () => {
        it('active(ref) matches on id', async () => {
            const keyring = buildSecureStoreMock({ secret: 'tok_a' })
            mockedCreateSecureStore.mockReturnValue(keyring)
            const { store: userRecords, state } = buildUserRecords()
            state.records.set('1', { id: '1', account: { id: '1', label: 'me', email: 'a@b' } })
            state.records.set('2', {
                id: '2',
                account: { id: '2', label: 'you', email: 'c@d' },
                fallbackToken: 'tok_b',
            })

            const store = createKeyringTokenStore<Account>({ serviceName: SERVICE, userRecords })

            const snapshot = await store.active('2')
            expect(snapshot?.account.id).toBe('2')
            expect(snapshot?.token).toBe('tok_b')
        })

        it('active(ref) matches on label', async () => {
            const keyring = buildSecureStoreMock({ secret: 'tok' })
            mockedCreateSecureStore.mockReturnValue(keyring)
            const { store: userRecords, state } = buildUserRecords()
            state.records.set('1', { id: '1', account: { id: '1', label: 'alice', email: 'a@b' } })

            const store = createKeyringTokenStore<Account>({ serviceName: SERVICE, userRecords })

            const snapshot = await store.active('alice')
            expect(snapshot?.account.id).toBe('1')
        })

        it('active(ref) returns null on a miss (attacher translates to ACCOUNT_NOT_FOUND)', async () => {
            mockedCreateSecureStore.mockReturnValue(buildSecureStoreMock())
            const { store: userRecords, state } = buildUserRecords()
            state.records.set('1', { id: '1', account })

            const store = createKeyringTokenStore<Account>({ serviceName: SERVICE, userRecords })

            await expect(store.active('does-not-exist')).resolves.toBeNull()
        })

        it('clear(ref) removes only the matching record', async () => {
            const keyring = buildSecureStoreMock()
            mockedCreateSecureStore.mockReturnValue(keyring)
            const { store: userRecords, state } = buildUserRecords()
            state.records.set('1', { id: '1', account: { id: '1', label: 'a', email: 'a@b' } })
            state.records.set('2', { id: '2', account: { id: '2', label: 'b', email: 'c@d' } })
            state.defaultId = '1'

            const store = createKeyringTokenStore<Account>({ serviceName: SERVICE, userRecords })

            await store.clear('2')

            expect(state.records.has('1')).toBe(true)
            expect(state.records.has('2')).toBe(false)
            expect(state.defaultId).toBe('1')
        })

        it('clear(ref) on a miss is a no-op (attacher rejects via active() pre-check)', async () => {
            mockedCreateSecureStore.mockReturnValue(buildSecureStoreMock())
            const { store: userRecords, state } = buildUserRecords()
            state.records.set('1', { id: '1', account })

            const store = createKeyringTokenStore<Account>({ serviceName: SERVICE, userRecords })

            await store.clear('nope')
            expect(state.records.has('1')).toBe(true)
        })

        it('honours a custom matchAccount predicate', async () => {
            const keyring = buildSecureStoreMock({ secret: 'tok' })
            mockedCreateSecureStore.mockReturnValue(keyring)
            const { store: userRecords, state } = buildUserRecords()
            state.records.set('1', { id: '1', account: { id: '1', email: 'Alice@x.io' } })

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
            mockedCreateSecureStore.mockReturnValue(buildSecureStoreMock())
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
            mockedCreateSecureStore.mockReturnValue(buildSecureStoreMock())
            const { store: userRecords } = buildUserRecords()

            const store = createKeyringTokenStore<Account>({ serviceName: SERVICE, userRecords })

            await expect(store.list()).resolves.toEqual([])
        })

        it('setDefault(ref) marks the matching account as default', async () => {
            mockedCreateSecureStore.mockReturnValue(buildSecureStoreMock())
            const { store: userRecords, state } = buildUserRecords()
            state.records.set('1', { id: '1', account: { id: '1', label: 'a', email: 'a@b' } })
            state.records.set('2', { id: '2', account: { id: '2', label: 'b', email: 'c@d' } })
            state.defaultId = '1'

            const store = createKeyringTokenStore<Account>({ serviceName: SERVICE, userRecords })

            await store.setDefault('b')
            expect(state.defaultId).toBe('2')
        })

        it('setDefault(ref) throws ACCOUNT_NOT_FOUND on a miss', async () => {
            mockedCreateSecureStore.mockReturnValue(buildSecureStoreMock())
            const { store: userRecords, state } = buildUserRecords()
            state.records.set('1', { id: '1', account })

            const store = createKeyringTokenStore<Account>({ serviceName: SERVICE, userRecords })

            await expect(store.setDefault('nope')).rejects.toMatchObject({
                code: 'ACCOUNT_NOT_FOUND',
            })
        })
    })
})
