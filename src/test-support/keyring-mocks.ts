import { vi } from 'vitest'

import type { SecureStore } from '../auth/keyring/secure-store.js'
import type { UserRecord, UserRecordStore } from '../auth/keyring/types.js'
import type { AuthAccount } from '../auth/types.js'

// Test mocks shared between the keyring unit suites. Lives under
// `src/test-support/` so it's excluded from the build (per
// `tsconfig.build.json`) and never reaches consumers via `dist/`.

export type KeyringSlot = {
    secret: string | null
    getErr?: unknown
    setErr?: unknown
    delErr?: unknown
}

export type KeyringMap = {
    create: (args: { serviceName: string; account: string }) => SecureStore
    slots: Map<string, KeyringSlot>
    deleteCalls: Map<string, number>
}

/**
 * Keyed multi-slot keyring mock. Each `account` (slug) gets its own state
 * blob so tests can verify that `active()` / `clear()` actually route to the
 * right per-user slot. Errors can be pre-seeded per slot.
 */
export function buildKeyringMap(): KeyringMap {
    const slots = new Map<string, KeyringSlot>()
    const deleteCalls = new Map<string, number>()
    function getSlot(account: string): KeyringSlot {
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

export type SingleSlotMock = SecureStore & {
    getSpy: ReturnType<typeof vi.fn>
    setSpy: ReturnType<typeof vi.fn>
    deleteSpy: ReturnType<typeof vi.fn>
}

/**
 * Simple single-slot keyring mock with spies on each method. Use for tests
 * that don't care about per-user slot routing.
 */
export function buildSingleSlot(initial: { secret?: string | null } = {}): SingleSlotMock {
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

export type UserRecordsHarness<TAccount extends AuthAccount> = {
    store: UserRecordStore<TAccount>
    state: {
        records: Map<string, UserRecord<TAccount>>
        defaultId: string | null
    }
    upsertSpy: ReturnType<typeof vi.fn>
    removeSpy: ReturnType<typeof vi.fn>
    setDefaultSpy: ReturnType<typeof vi.fn>
}

/** In-memory `UserRecordStore` with spies on the mutating methods. */
export function buildUserRecords<TAccount extends AuthAccount>(
    options: { location?: string } = {},
): UserRecordsHarness<TAccount> {
    const location = options.location ?? '/tmp/fake/config.json'
    const state = {
        records: new Map<string, UserRecord<TAccount>>(),
        defaultId: null as string | null,
    }
    const upsertSpy = vi.fn(async (record: UserRecord<TAccount>) => {
        state.records.set(record.id, record)
    })
    const removeSpy = vi.fn(async (id: string) => {
        state.records.delete(id)
    })
    const setDefaultSpy = vi.fn(async (id: string | null) => {
        state.defaultId = id
    })
    const store: UserRecordStore<TAccount> = {
        async list() {
            return [...state.records.values()]
        },
        upsert: upsertSpy,
        remove: removeSpy,
        async getDefaultId() {
            return state.defaultId
        },
        setDefaultId: setDefaultSpy,
        describeLocation() {
            return location
        },
    }
    return { store, state, upsertSpy, removeSpy, setDefaultSpy }
}
