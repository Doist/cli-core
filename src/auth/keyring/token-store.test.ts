import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
    buildKeyringMap,
    buildSingleSlot,
    buildUserRecords,
} from '../../test-support/keyring-mocks.js'
import type { TokenBundle } from '../types.js'
import { SecureStoreUnavailableError } from './secure-store.js'
import { refreshAccountSlot } from './slot-naming.js'
import { type CreateKeyringTokenStoreOptions, createKeyringTokenStore } from './token-store.js'
import type { UserRecord } from './types.js'

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
const LOCATION = '/tmp/fake/config.json'
const account: Account = { id: '42', label: 'me', email: 'a@b.c' }

type SingleSlot = ReturnType<typeof buildSingleSlot>

/**
 * One-shot setup: wire `createSecureStore` to return `keyring`, seed any
 * `records` / `defaultId` into a fresh `buildUserRecords` harness, and
 * construct a store with the standard factory options. Returns the harness
 * pieces tests typically reach for.
 */
function fixture(
    opts: {
        keyring?: SingleSlot
        records?: Record<string, UserRecord<Account>>
        defaultId?: string | null
        factoryOpts?: Partial<CreateKeyringTokenStoreOptions<Account>>
    } = {},
) {
    const keyring = opts.keyring ?? buildSingleSlot()
    mockedCreateSecureStore.mockReturnValue(keyring)
    const harness = buildUserRecords<Account>()
    for (const [id, rec] of Object.entries(opts.records ?? {})) {
        harness.state.records.set(id, rec)
    }
    if (opts.defaultId !== undefined) harness.state.defaultId = opts.defaultId
    const store = createKeyringTokenStore<Account>({
        serviceName: SERVICE,
        userRecords: harness.store,
        recordsLocation: LOCATION,
        ...opts.factoryOpts,
    })
    return {
        keyring,
        store,
        state: harness.state,
        upsertSpy: harness.upsertSpy,
        removeSpy: harness.removeSpy,
        setDefaultSpy: harness.setDefaultSpy,
    }
}

describe('createKeyringTokenStore', () => {
    beforeEach(() => {
        mockedCreateSecureStore.mockReset()
    })

    it('round-trips set → active → clear when the keyring is online', async () => {
        // Per-slot map: set() now wipes the refresh slot too, so a
        // single-slot mock would clobber the access secret.
        const km = buildKeyringMap()
        mockedCreateSecureStore.mockImplementation(km.create)
        const harness = buildUserRecords<Account>()
        const store = createKeyringTokenStore<Account>({
            serviceName: SERVICE,
            userRecords: harness.store,
            recordsLocation: LOCATION,
        })

        await store.set(account, 'tok_secret')
        expect(km.slots.get('user-42')?.secret).toBe('tok_secret')
        expect(harness.upsertSpy).toHaveBeenCalledWith({ account, hasRefreshToken: false })
        expect(harness.state.defaultId).toBe('42')
        expect(store.getLastStorageResult()).toEqual({ storage: 'secure-store' })

        await expect(store.active()).resolves.toEqual({ token: 'tok_secret', account })

        await store.clear()
        expect(km.slots.get('user-42')?.secret).toBeNull()
        expect(km.slots.get(refreshAccountSlot('user-42'))?.secret).toBeNull()
        expect(harness.state.records.size).toBe(0)
        expect(harness.state.defaultId).toBeNull()
        expect(store.getLastClearResult()).toEqual({ storage: 'secure-store' })
    })

    it('falls back to a plaintext token on the user record when the keyring is offline', async () => {
        const keyring = buildSingleSlot()
        keyring.setSpy.mockRejectedValueOnce(new SecureStoreUnavailableError('no dbus'))
        const { store, state } = fixture({ keyring })

        await store.set(account, 'tok_plain')

        expect(state.records.get('42')?.fallbackToken).toBe('tok_plain')
        // `set()` writes `hasRefreshToken: false` definitively, so the next
        // `active()` skips the refresh-slot IPC entirely.
        expect(state.records.get('42')?.hasRefreshToken).toBe(false)
        expect(store.getLastStorageResult()).toEqual({
            storage: 'config-file',
            warning:
                'system credential manager unavailable; token saved as plaintext in /tmp/fake/config.json',
        })

        await expect(store.active()).resolves.toEqual({ token: 'tok_plain', account })
        expect(keyring.getSpy).not.toHaveBeenCalled()
    })

    it('set() still succeeds when the best-effort default promotion fails', async () => {
        const { store, state, setDefaultSpy } = fixture()
        setDefaultSpy.mockRejectedValueOnce(new Error('default-write blew up'))

        await expect(store.set(account, 'tok')).resolves.toBeUndefined()
        expect(state.records.get('42')?.account).toEqual(account)
        // Default never got set because the write failed, but the user record is durable.
        expect(state.defaultId).toBeNull()
    })

    it('resets getLastStorageResult to undefined when set() throws', async () => {
        const { store, upsertSpy } = fixture()
        await store.set(account, 'tok')
        expect(store.getLastStorageResult()).toEqual({ storage: 'secure-store' })

        // Second call throws — the previous result must not leak through.
        upsertSpy.mockRejectedValueOnce(new Error('disk full'))
        await expect(store.set({ ...account, id: '99' }, 'tok2')).rejects.toThrow('disk full')
        expect(store.getLastStorageResult()).toBeUndefined()
    })

    it.each([
        [
            'the keyring read throws',
            (k: SingleSlot) => {
                k.getSpy.mockRejectedValueOnce(new SecureStoreUnavailableError('locked'))
            },
        ],
        [
            'the keyring slot is empty (out-of-band deletion)',
            () => {
                // default null secret — collapsing to `null` would surface as
                // ACCOUNT_NOT_FOUND on `--user <ref>` and hide the corruption.
            },
        ],
    ])('throws AUTH_STORE_READ_FAILED when a record matches but %s', async (_label, setup) => {
        const keyring = buildSingleSlot()
        setup(keyring)
        const { store } = fixture({ keyring, records: { '42': { account } }, defaultId: '42' })

        await expect(store.active()).rejects.toMatchObject({ code: 'AUTH_STORE_READ_FAILED' })
    })

    it('picks the lone user when no default is set', async () => {
        // Per-slot keyring map so refresh probes (legacy record) hit an
        // empty distinct slot rather than the same single-slot secret.
        const km = buildKeyringMap()
        mockedCreateSecureStore.mockImplementation(km.create)
        const harness = buildUserRecords<Account>()
        harness.state.records.set('42', { account })
        km.slots.set('user-42', { secret: 'tok' })
        const store = createKeyringTokenStore<Account>({
            serviceName: SERVICE,
            userRecords: harness.store,
            recordsLocation: LOCATION,
        })

        await expect(store.active()).resolves.toEqual({ token: 'tok', account })
    })

    it('throws NO_ACCOUNT_SELECTED when multiple users exist and no default is set', async () => {
        // `setDefaultId` is best-effort during `set()`, so this state IS
        // reachable in practice. Collapsing to `null` would surface as
        // `NOT_AUTHENTICATED` and hide the real recovery action.
        const { store } = fixture({
            records: {
                '1': { account: { ...account, id: '1' } },
                '2': { account: { ...account, id: '2' } },
            },
        })

        await expect(store.active()).rejects.toMatchObject({ code: 'NO_ACCOUNT_SELECTED' })
    })

    it('throws NO_ACCOUNT_SELECTED when --user <ref> matches more than one record (ambiguous)', async () => {
        // Default matcher considers `account.label`, which the contract
        // doesn't require to be unique. Silently picking the first match
        // would act on whichever record `list()` returned first.
        const { store } = fixture({
            records: {
                '1': { account: { id: '1', label: 'shared', email: 'a@b' } },
                '2': { account: { id: '2', label: 'shared', email: 'c@d' } },
            },
        })

        await expect(store.active('shared')).rejects.toMatchObject({ code: 'NO_ACCOUNT_SELECTED' })
    })

    it('does not overwrite an existing default when a second user is added', async () => {
        const { store, state } = fixture({
            records: { '1': { account: { ...account, id: '1' } } },
            defaultId: '1',
        })

        await store.set({ ...account, id: '2' }, 'tok_b')

        expect(state.defaultId).toBe('1')
    })

    it('clear() still calls the keyring delete when a fallbackToken is present (orphan cleanup)', async () => {
        const keyring = buildSingleSlot({ secret: 'orphan_from_earlier_write' })
        const { store, state } = fixture({
            keyring,
            records: { '42': { account, fallbackToken: 'tok_plain' } },
            defaultId: '42',
        })

        await store.clear()

        // Both slots wiped — access + refresh. Single-slot mock counts both.
        expect(keyring.deleteSpy).toHaveBeenCalledTimes(2)
        expect(state.records.size).toBe(0)
        expect(store.getLastClearResult()).toEqual({
            storage: 'config-file',
            warning:
                'system credential manager unavailable; local auth state cleared in /tmp/fake/config.json',
        })
    })

    it('clear() downgrades a non-keyring delete error to a warning (local state is already gone)', async () => {
        // After `remove()` the record is gone locally; re-throwing the
        // `deleteSecret()` error would corrupt the caller's mental model.
        const keyring = buildSingleSlot({ secret: 'tok' })
        keyring.deleteSpy.mockRejectedValueOnce(new Error('IPC stalled'))
        const { store, state } = fixture({
            keyring,
            records: { '42': { account } },
            defaultId: '42',
        })

        await store.clear()

        expect(state.records.size).toBe(0)
        expect(store.getLastClearResult()).toMatchObject({ storage: 'config-file' })
    })

    it('clear() does not attempt the keyring delete when userRecords.remove() rejects', async () => {
        // Record-first contract: if the source-of-truth removal fails, the
        // keyring entry must remain so a retry stays consistent.
        const keyring = buildSingleSlot({ secret: 'tok' })
        const { store, state, removeSpy } = fixture({
            keyring,
            records: { '42': { account } },
            defaultId: '42',
        })
        removeSpy.mockRejectedValueOnce(new Error('disk full'))

        await expect(store.clear()).rejects.toThrow('disk full')
        expect(keyring.deleteSpy).not.toHaveBeenCalled()
        expect(state.records.has('42')).toBe(true)
    })

    it('clear() still deletes the keyring slot even when setDefaultId(null) throws', async () => {
        const keyring = buildSingleSlot({ secret: 'tok' })
        const { store, state, setDefaultSpy } = fixture({
            keyring,
            records: { '42': { account, hasRefreshToken: false } },
            defaultId: '42',
        })
        setDefaultSpy.mockRejectedValueOnce(new Error('disk full'))

        await store.clear()

        // Default pointer write blew up, but the keyring entries were still
        // cleaned up — otherwise the credentials become unreachable orphans.
        // Both slots (access + refresh) are wiped.
        expect(keyring.deleteSpy).toHaveBeenCalledTimes(2)
        expect(state.records.size).toBe(0)
    })

    it('uses a custom accountForUser slug when provided', async () => {
        const { store } = fixture({ factoryOpts: { accountForUser: (id) => `custom-${id}` } })

        await store.set(account, 'tok')

        expect(mockedCreateSecureStore).toHaveBeenCalledWith({
            serviceName: SERVICE,
            account: 'custom-42',
        })
    })

    describe('AccountRef support (keyed per-user slots)', () => {
        function multiUserFixture() {
            const km = buildKeyringMap()
            mockedCreateSecureStore.mockImplementation(km.create)
            const harness = buildUserRecords<Account>()
            harness.state.records.set('1', { account: { id: '1', label: 'alice', email: 'a@b' } })
            harness.state.records.set('2', {
                account: { id: '2', label: 'bob', email: 'c@d' },
                fallbackToken: 'tok_b',
            })
            km.slots.set('user-1', { secret: 'tok_a' })
            const store = createKeyringTokenStore<Account>({
                serviceName: SERVICE,
                userRecords: harness.store,
                recordsLocation: LOCATION,
            })
            return { km, store, state: harness.state }
        }

        it('active(ref) reads from the matching per-user slot', async () => {
            const { km, store } = multiUserFixture()

            const snapshot = await store.active('1')
            expect(snapshot?.account.id).toBe('1')
            expect(snapshot?.token).toBe('tok_a')
            // Sanity check: user 2's keyring slot was never touched (its
            // record carries `fallbackToken`).
            expect(km.slots.has('user-2')).toBe(false)
        })

        it('active(ref) prefers the fallbackToken over a stale keyring entry', async () => {
            const { km, store } = multiUserFixture()
            // Simulate an orphan keyring entry left from a prior online write.
            km.slots.set('user-2', { secret: 'tok_b_stale' })

            await expect(store.active('2')).resolves.toMatchObject({ token: 'tok_b' })
        })

        it('active(ref) returns null on a miss (attacher translates to ACCOUNT_NOT_FOUND)', async () => {
            const { store } = multiUserFixture()
            await expect(store.active('does-not-exist')).resolves.toBeNull()
        })

        it('clear(ref) removes the matching record and deletes only its keyring slot', async () => {
            const { km, store, state } = multiUserFixture()
            state.defaultId = '1'

            await store.clear('1')

            expect(state.records.has('1')).toBe(false)
            expect(state.records.has('2')).toBe(true)
            expect(state.defaultId).toBeNull()
            expect(km.slots.get('user-1')?.secret).toBeNull()
            expect((km.deleteCalls.get('user-1') ?? 0) > 0).toBe(true)
            expect(km.deleteCalls.has('user-2')).toBe(false)
        })

        it('honours a custom matchAccount predicate', async () => {
            const km = buildKeyringMap()
            mockedCreateSecureStore.mockImplementation(km.create)
            const harness = buildUserRecords<Account>()
            harness.state.records.set('1', { account: { id: '1', email: 'Alice@x.io' } })
            km.slots.set('user-1', { secret: 'tok' })

            const store = createKeyringTokenStore<Account>({
                serviceName: SERVICE,
                userRecords: harness.store,
                recordsLocation: LOCATION,
                matchAccount: (acc, ref) => acc.email.toLowerCase() === ref.toLowerCase(),
            })

            await expect(store.active('alice@x.io')).resolves.toMatchObject({
                account: { id: '1' },
            })
        })
    })

    describe('list() + setDefault()', () => {
        const a: Account = { id: '1', label: 'a', email: 'a@b' }
        const b: Account = { id: '2', label: 'b', email: 'c@d' }

        it('returns every account with the default marker', async () => {
            const { store } = fixture({
                records: { '1': { account: a }, '2': { account: b } },
                defaultId: '2',
            })

            const all = await store.list()
            expect(all).toHaveLength(2)
            expect(all.find((entry) => entry.account.id === '2')?.isDefault).toBe(true)
            expect(all.find((entry) => entry.account.id === '1')?.isDefault).toBe(false)
        })

        it('marks a single record as default even when no defaultId is pinned (matches active())', async () => {
            const { store } = fixture({ records: { '42': { account } } })

            await expect(store.list()).resolves.toEqual([{ account, isDefault: true }])
        })

        it('returns every account with isDefault:false when multiple records exist and no default is pinned', async () => {
            // `active()` throws `NO_ACCOUNT_SELECTED` in this state, but
            // `list()` is a diagnostic operation that must keep working.
            const { store } = fixture({
                records: { '1': { account: a }, '2': { account: b } },
            })

            const all = await store.list()
            expect(all).toHaveLength(2)
            expect(all.every((entry) => entry.isDefault === false)).toBe(true)
        })

        it('setDefault(ref) marks the matching account as default', async () => {
            const { store, state } = fixture({
                records: { '1': { account: a }, '2': { account: b } },
                defaultId: '1',
            })

            await store.setDefault('b')
            expect(state.defaultId).toBe('2')
            expect(mockedCreateSecureStore).not.toHaveBeenCalled()
        })

        it('setDefault(ref) throws ACCOUNT_NOT_FOUND on a miss', async () => {
            const { store } = fixture({ records: { '1': { account } } })

            await expect(store.setDefault('nope')).rejects.toMatchObject({
                code: 'ACCOUNT_NOT_FOUND',
            })
        })
    })

    describe('setBundle / active() bundle round-trip', () => {
        function mapFixture(
            records: Record<string, UserRecord<Account>> = {},
            defaultId: string | null = null,
        ) {
            const km = buildKeyringMap()
            mockedCreateSecureStore.mockImplementation(km.create)
            const harness = buildUserRecords<Account>()
            for (const [id, rec] of Object.entries(records)) {
                harness.state.records.set(id, rec)
            }
            harness.state.defaultId = defaultId
            const store = createKeyringTokenStore<Account>({
                serviceName: SERVICE,
                userRecords: harness.store,
                recordsLocation: LOCATION,
            })
            return { km, store, state: harness.state, upsertSpy: harness.upsertSpy }
        }

        const bundle: TokenBundle = {
            accessToken: 'tok_a',
            refreshToken: 'tok_r',
            accessTokenExpiresAt: 1_700_000_000_000,
        }

        it('round-trips set → active with the full bundle', async () => {
            const { km, store, state } = mapFixture()

            await store.setBundle(account, bundle, { promoteDefault: true })

            // Both slots written
            expect(km.slots.get('user-42')?.secret).toBe('tok_a')
            expect(km.slots.get(refreshAccountSlot('user-42'))?.secret).toBe('tok_r')
            // Record carries the gate + expiry, no plaintext fallbacks
            const record = state.records.get('42')
            expect(record?.hasRefreshToken).toBe(true)
            expect(record?.accessTokenExpiresAt).toBe(1_700_000_000_000)
            expect(record?.fallbackToken).toBeUndefined()
            expect(record?.fallbackRefreshToken).toBeUndefined()
            expect(state.defaultId).toBe('42')

            // Active resolves both tokens — flat snapshot, no `bundle` wrapper.
            await expect(store.active()).resolves.toEqual({
                token: 'tok_a',
                account,
                refreshToken: 'tok_r',
                accessTokenExpiresAt: 1_700_000_000_000,
            })
        })

        it('omits refresh-state fields on active() when nothing refresh-related is stored', async () => {
            const { store } = mapFixture()
            await store.set(account, 'tok_a')

            await expect(store.active()).resolves.toEqual({ token: 'tok_a', account })
        })

        it('omits promoteDefault by default (silent-refresh path does not re-pin)', async () => {
            const { store, state } = mapFixture({
                '42': { account, hasRefreshToken: false },
            })

            await store.setBundle(account, bundle)

            expect(state.defaultId).toBeNull()
        })

        it('skips the refresh-slot IPC when hasRefreshToken is false', async () => {
            const { km, store } = mapFixture({
                '42': { account, hasRefreshToken: false },
            })
            km.slots.set('user-42', { secret: 'tok_a' })
            // Seed an orphan refresh slot — verify it is NOT consulted.
            km.slots.set(refreshAccountSlot('user-42'), { secret: 'orphan_r' })

            const active = await store.active()
            expect(active?.token).toBe('tok_a')
            expect(active?.refreshToken).toBeUndefined()
            // Hard assertion: refresh-slot getSecret was never invoked.
            expect(km.getCalls.has(refreshAccountSlot('user-42'))).toBe(false)
        })

        it('probes the refresh slot when hasRefreshToken is undefined (legacy record)', async () => {
            const { km, store, state } = mapFixture({ '42': { account } })
            km.slots.set('user-42', { secret: 'tok_a' })
            km.slots.set(refreshAccountSlot('user-42'), { secret: 'tok_r' })

            await expect(store.active()).resolves.toMatchObject({ refreshToken: 'tok_r' })
            // Legacy records pay the probe on every read — no race-prone
            // backfill. A subsequent `setBundle` will write `hasRefreshToken`
            // explicitly.
            expect(state.records.get('42')?.hasRefreshToken).toBeUndefined()
        })

        it.each([
            {
                label: 'SecureStoreUnavailableError → downgrade to no-refresh',
                err: new SecureStoreUnavailableError('locked'),
                expect: 'downgrade' as const,
            },
            {
                label: 'non-keyring error → AUTH_STORE_READ_FAILED',
                err: new Error('disk fried'),
                expect: 'throw' as const,
            },
        ])('refresh-slot read: $label', async ({ err, expect: outcome }) => {
            const { km, store } = mapFixture({ '42': { account, hasRefreshToken: true } })
            km.slots.set('user-42', { secret: 'tok_a' })
            km.slots.set(refreshAccountSlot('user-42'), { secret: 'tok_r', getErr: err })

            if (outcome === 'downgrade') {
                const result = await store.active()
                expect(result?.token).toBe('tok_a')
                expect(result).not.toHaveProperty('refreshToken')
            } else {
                await expect(store.active()).rejects.toMatchObject({
                    code: 'AUTH_STORE_READ_FAILED',
                })
            }
        })

        it('set() wipes the refresh slot left behind by a prior setBundle', async () => {
            // Regression: `set(account, token)` is documented as "replacing
            // any previous entry". Without the wipe, a later set() would
            // leave the refresh secret orphaned in the keyring even though
            // the record's `hasRefreshToken: false` says it shouldn't be
            // there.
            const { km, store, state } = mapFixture()

            await store.setBundle(account, bundle, { promoteDefault: true })
            expect(km.slots.get(refreshAccountSlot('user-42'))?.secret).toBe('tok_r')

            await store.set(account, 'tok_a_replacement')

            expect(km.slots.get('user-42')?.secret).toBe('tok_a_replacement')
            expect(km.slots.get(refreshAccountSlot('user-42'))?.secret).toBeNull()
            expect(state.records.get('42')?.hasRefreshToken).toBe(false)
        })

        it('clear() wipes both keyring slots', async () => {
            const { km, store, state } = mapFixture({
                '42': { account, hasRefreshToken: true },
            })
            km.slots.set('user-42', { secret: 'tok_a' })
            km.slots.set(refreshAccountSlot('user-42'), { secret: 'tok_r' })
            state.defaultId = '42'

            await store.clear()

            expect(state.records.size).toBe(0)
            expect(km.slots.get('user-42')?.secret).toBeNull()
            expect(km.slots.get(refreshAccountSlot('user-42'))?.secret).toBeNull()
        })
    })
})
