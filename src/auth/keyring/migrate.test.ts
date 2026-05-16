import { beforeEach, describe, expect, it, vi } from 'vitest'

import { migrateLegacyAuth } from './migrate.js'
import { SecureStoreUnavailableError, type SecureStore } from './secure-store.js'
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

function buildKeyringMap(): {
    create: (args: { serviceName: string; account: string }) => SecureStore
    slots: Map<
        string,
        { secret: string | null; getErr?: unknown; setErr?: unknown; delErr?: unknown }
    >
} {
    const slots = new Map<
        string,
        {
            secret: string | null
            getErr?: unknown
            setErr?: unknown
            delErr?: unknown
        }
    >()
    function getSlot(account: string) {
        let slot = slots.get(account)
        if (!slot) {
            slot = { secret: null }
            slots.set(account, slot)
        }
        return slot
    }
    return {
        slots,
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

function buildUserRecords(): {
    store: UserRecordStore<Account>
    state: {
        records: Map<string, UserRecord<Account>>
        defaultId: string | null
    }
    upsertSpy: ReturnType<typeof vi.fn>
} {
    const state = {
        records: new Map<string, UserRecord<Account>>(),
        defaultId: null as string | null,
    }
    const upsertSpy = vi.fn(async (record: UserRecord<Account>) => {
        state.records.set(record.id, record)
    })
    const store: UserRecordStore<Account> = {
        async list() {
            return [...state.records.values()]
        },
        async getById(id) {
            return state.records.get(id) ?? null
        },
        upsert: upsertSpy,
        async remove(id) {
            state.records.delete(id)
        },
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
    return { store, state, upsertSpy }
}

const SERVICE = 'cli-core-test'
const LEGACY = 'api-token'

describe('migrateLegacyAuth', () => {
    beforeEach(() => {
        mockedCreateSecureStore.mockReset()
    })

    it('returns already-migrated when user records already exist', async () => {
        mockedCreateSecureStore.mockReturnValue(
            buildKeyringMap().create({ serviceName: SERVICE, account: LEGACY }),
        )
        const { store: userRecords, state } = buildUserRecords()
        state.records.set('1', { id: '1', account: { id: '1', email: 'a@b' } })

        const result = await migrateLegacyAuth<Account>({
            serviceName: SERVICE,
            legacyAccount: LEGACY,
            userRecords,
            loadLegacyPlaintextToken: async () => null,
            identifyAccount: async () => ({ id: '1', email: 'a@b' }),
            silent: true,
        })

        expect(result.status).toBe('already-migrated')
    })

    it('returns no-legacy-state when neither slot has a token', async () => {
        const km = buildKeyringMap()
        mockedCreateSecureStore.mockImplementation(km.create)
        const { store: userRecords } = buildUserRecords()

        const result = await migrateLegacyAuth<Account>({
            serviceName: SERVICE,
            legacyAccount: LEGACY,
            userRecords,
            loadLegacyPlaintextToken: async () => null,
            identifyAccount: async () => ({ id: '1', email: 'a@b' }),
            silent: true,
        })

        expect(result.status).toBe('no-legacy-state')
    })

    it('migrates a legacy keyring token into a per-user slot and clears the legacy entry', async () => {
        const km = buildKeyringMap()
        km.slots.set(LEGACY, { secret: 'legacy_tok' })
        mockedCreateSecureStore.mockImplementation(km.create)
        const { store: userRecords, state, upsertSpy } = buildUserRecords()
        const cleanup = vi.fn(async () => undefined)

        const result = await migrateLegacyAuth<Account>({
            serviceName: SERVICE,
            legacyAccount: LEGACY,
            userRecords,
            loadLegacyPlaintextToken: async () => null,
            identifyAccount: async (token) => {
                expect(token).toBe('legacy_tok')
                return { id: '99', email: 'me@x.io', label: 'me@x.io' }
            },
            cleanupLegacyConfig: cleanup,
            silent: true,
        })

        expect(result.status).toBe('migrated')
        expect(result.migratedAccount?.id).toBe('99')
        expect(km.slots.get('user-99')?.secret).toBe('legacy_tok')
        expect(km.slots.get(LEGACY)?.secret).toBeNull()
        expect(state.records.get('99')?.fallbackToken).toBeUndefined()
        expect(state.defaultId).toBe('99')
        expect(upsertSpy).toHaveBeenCalledTimes(1)
        expect(cleanup).toHaveBeenCalledTimes(1)
    })

    it('falls back to loadLegacyPlaintextToken when the legacy keyring slot is empty', async () => {
        const km = buildKeyringMap()
        mockedCreateSecureStore.mockImplementation(km.create)
        const { store: userRecords, state } = buildUserRecords()

        const result = await migrateLegacyAuth<Account>({
            serviceName: SERVICE,
            legacyAccount: LEGACY,
            userRecords,
            loadLegacyPlaintextToken: async () => 'plain_legacy',
            identifyAccount: async () => ({ id: '7', email: 'p@l.x' }),
            silent: true,
        })

        expect(result.status).toBe('migrated')
        expect(km.slots.get('user-7')?.secret).toBe('plain_legacy')
        expect(state.records.get('7')?.fallbackToken).toBeUndefined()
    })

    it('migrates against an entirely offline keyring (WSL/headless)', async () => {
        const km = buildKeyringMap()
        // The whole keyring is dead: reading the legacy slot throws and
        // writing the per-user slot would too. Migration must still complete
        // by sourcing the token from the consumer's plaintext slot and
        // parking it on the user record as `fallbackToken`.
        km.slots.set(LEGACY, {
            secret: null,
            getErr: new SecureStoreUnavailableError('no dbus'),
        })
        km.slots.set('user-7', {
            secret: null,
            setErr: new SecureStoreUnavailableError('no dbus'),
        })
        mockedCreateSecureStore.mockImplementation(km.create)
        const { store: userRecords, state } = buildUserRecords()

        const result = await migrateLegacyAuth<Account>({
            serviceName: SERVICE,
            legacyAccount: LEGACY,
            userRecords,
            loadLegacyPlaintextToken: async () => 'plain_legacy',
            identifyAccount: async () => ({ id: '7', email: 'p@l.x' }),
            silent: true,
        })

        expect(result.status).toBe('migrated')
        expect(state.records.get('7')?.fallbackToken).toBe('plain_legacy')
        expect(state.defaultId).toBe('7')
    })

    it('stores fallbackToken on the record when the per-user keyring write fails', async () => {
        const km = buildKeyringMap()
        km.slots.set(LEGACY, { secret: 'legacy_tok' })
        km.slots.set('user-99', {
            secret: null,
            setErr: new SecureStoreUnavailableError('offline'),
        })
        mockedCreateSecureStore.mockImplementation(km.create)
        const { store: userRecords, state } = buildUserRecords()

        const result = await migrateLegacyAuth<Account>({
            serviceName: SERVICE,
            legacyAccount: LEGACY,
            userRecords,
            loadLegacyPlaintextToken: async () => null,
            identifyAccount: async () => ({ id: '99', email: 'me@x.io' }),
            silent: true,
        })

        expect(result.status).toBe('migrated')
        expect(state.records.get('99')?.fallbackToken).toBe('legacy_tok')
    })

    it('returns skipped when identifyAccount throws', async () => {
        const km = buildKeyringMap()
        km.slots.set(LEGACY, { secret: 'legacy_tok' })
        mockedCreateSecureStore.mockImplementation(km.create)
        const { store: userRecords, state } = buildUserRecords()

        const result = await migrateLegacyAuth<Account>({
            serviceName: SERVICE,
            legacyAccount: LEGACY,
            userRecords,
            loadLegacyPlaintextToken: async () => null,
            identifyAccount: async () => {
                throw new Error('HTTP 401')
            },
            silent: true,
        })

        expect(result.status).toBe('skipped')
        expect(result.reason).toContain('HTTP 401')
        expect(state.records.size).toBe(0)
        // Legacy entry must remain so a retry can find it.
        expect(km.slots.get(LEGACY)?.secret).toBe('legacy_tok')
    })

    it('rolls back the keyring write when user-record upsert fails', async () => {
        const km = buildKeyringMap()
        km.slots.set(LEGACY, { secret: 'legacy_tok' })
        mockedCreateSecureStore.mockImplementation(km.create)
        const { store: userRecords, upsertSpy } = buildUserRecords()
        upsertSpy.mockRejectedValueOnce(new Error('disk full'))

        const result = await migrateLegacyAuth<Account>({
            serviceName: SERVICE,
            legacyAccount: LEGACY,
            userRecords,
            loadLegacyPlaintextToken: async () => null,
            identifyAccount: async () => ({ id: '99', email: 'me@x.io' }),
            silent: true,
        })

        expect(result.status).toBe('skipped')
        expect(km.slots.get('user-99')?.secret).toBeNull()
    })
})
