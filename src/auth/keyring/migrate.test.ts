import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { buildKeyringMap, buildUserRecords } from '../../test-support/keyring-mocks.js'
import { migrateLegacyAuth, type MigrateLegacyAuthOptions } from './migrate.js'
import { SecureStoreUnavailableError } from './secure-store.js'
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
const LEGACY = 'api-token'

type SlotSeed = { secret?: string | null; getErr?: unknown; setErr?: unknown; delErr?: unknown }

type MarkerState = { migrated: boolean; markFails?: unknown }

/**
 * One-shot setup: wire `createSecureStore` to a fresh `buildKeyringMap`,
 * seed any keyring slots and any pre-existing user records, expose a
 * mutable marker that the helper's `hasMigrated` / `markMigrated` callbacks
 * read and write, and run `migrateLegacyAuth` with sensible defaults plus
 * the supplied overrides.
 */
async function runMigration(
    opts: {
        slots?: Record<string, SlotSeed>
        seedRecords?: Record<string, UserRecord<Account>>
        seedDefaultId?: string
        marker?: MarkerState
        options?: Partial<MigrateLegacyAuthOptions<Account>>
    } = {},
) {
    const km = buildKeyringMap()
    for (const [slug, slot] of Object.entries(opts.slots ?? {})) {
        km.slots.set(slug, { secret: null, ...slot })
    }
    mockedCreateSecureStore.mockImplementation(km.create)

    const harness = buildUserRecords<Account>()
    for (const [id, rec] of Object.entries(opts.seedRecords ?? {})) {
        harness.state.records.set(id, rec)
    }
    if (opts.seedDefaultId !== undefined) harness.state.defaultId = opts.seedDefaultId

    const marker: MarkerState = opts.marker ?? { migrated: false }
    const markMigrated = vi.fn(async () => {
        if (marker.markFails) throw marker.markFails
        marker.migrated = true
    })

    const result = await migrateLegacyAuth<Account>({
        serviceName: SERVICE,
        legacyAccount: LEGACY,
        userRecords: harness.store,
        hasMigrated: async () => marker.migrated,
        markMigrated,
        loadLegacyPlaintextToken: async () => null,
        identifyAccount: async () => ({ id: '1', email: 'a@b' }),
        silent: true,
        ...opts.options,
    })

    return { km, harness, state: harness.state, marker, markMigrated, result }
}

describe('migrateLegacyAuth', () => {
    beforeEach(() => {
        mockedCreateSecureStore.mockReset()
    })

    it('returns already-migrated when the durable marker is set', async () => {
        const { result, markMigrated } = await runMigration({ marker: { migrated: true } })

        expect(result.status).toBe('already-migrated')
        // Locks the short-circuit: nothing about the keyring is touched.
        expect(mockedCreateSecureStore).not.toHaveBeenCalled()
        expect(markMigrated).not.toHaveBeenCalled()
    })

    it('returns no-legacy-state when neither slot has a token', async () => {
        const { result } = await runMigration()
        expect(result.status).toBe('no-legacy-state')
    })

    it('returns skipped(legacy-keyring-unreachable) when the keyring is offline and there is no plaintext fallback', async () => {
        // Token may exist in the keyring but we can't see it — collapsing
        // to `no-legacy-state` would tell the caller "nothing to migrate"
        // and they'd stop retrying. Surface the retryable failure instead.
        const { result } = await runMigration({
            slots: { [LEGACY]: { getErr: new SecureStoreUnavailableError('no dbus') } },
        })

        expect(result).toMatchObject({ status: 'skipped', reason: 'legacy-keyring-unreachable' })
    })

    it('migrates a legacy keyring token into a per-user slot and clears the legacy entry', async () => {
        const cleanup = vi.fn(async () => undefined)
        const { km, state, harness, result, marker, markMigrated } = await runMigration({
            slots: { [LEGACY]: { secret: 'legacy_tok' } },
            options: {
                identifyAccount: async (token) => {
                    expect(token).toBe('legacy_tok')
                    return { id: '99', email: 'me@x.io', label: 'me@x.io' }
                },
                cleanupLegacyConfig: cleanup,
            },
        })

        expect(result.status).toBe('migrated')
        if (result.status === 'migrated') expect(result.account.id).toBe('99')
        expect(km.slots.get('user-99')?.secret).toBe('legacy_tok')
        expect(km.slots.get(LEGACY)?.secret).toBeNull()
        expect(state.records.get('99')?.fallbackToken).toBeUndefined()
        expect(state.defaultId).toBe('99')
        expect(harness.upsertSpy).toHaveBeenCalledTimes(1)
        expect(cleanup).toHaveBeenCalledTimes(1)
        expect(markMigrated).toHaveBeenCalledTimes(1)
        expect(marker.migrated).toBe(true)
    })

    it('falls back to loadLegacyPlaintextToken when the legacy keyring slot is empty', async () => {
        const { km, state, result } = await runMigration({
            options: {
                loadLegacyPlaintextToken: async () => 'plain_legacy',
                identifyAccount: async () => ({ id: '7', email: 'p@l.x' }),
            },
        })

        expect(result.status).toBe('migrated')
        expect(km.slots.get('user-7')?.secret).toBe('plain_legacy')
        expect(state.records.get('7')?.fallbackToken).toBeUndefined()
    })

    it('migrates against an entirely offline keyring when the plaintext slot has the token (WSL/headless)', async () => {
        // The keyring is dead: reading the legacy slot throws and writing
        // the per-user slot would too. Migration must still complete by
        // sourcing the token from the consumer's plaintext slot and
        // parking it on the user record as `fallbackToken`.
        const { state, result } = await runMigration({
            slots: {
                [LEGACY]: { getErr: new SecureStoreUnavailableError('no dbus') },
                'user-7': { setErr: new SecureStoreUnavailableError('no dbus') },
            },
            options: {
                loadLegacyPlaintextToken: async () => 'plain_legacy',
                identifyAccount: async () => ({ id: '7', email: 'p@l.x' }),
            },
        })

        expect(result.status).toBe('migrated')
        expect(state.records.get('7')?.fallbackToken).toBe('plain_legacy')
        expect(state.defaultId).toBe('7')
    })

    it('returns skipped(identify-failed) when identifyAccount throws', async () => {
        const { km, state, result } = await runMigration({
            slots: { [LEGACY]: { secret: 'legacy_tok' } },
            options: {
                identifyAccount: async () => {
                    throw new Error('HTTP 401')
                },
            },
        })

        expect(result).toMatchObject({ status: 'skipped', reason: 'identify-failed' })
        if (result.status === 'skipped') expect(result.detail).toContain('HTTP 401')
        expect(state.records.size).toBe(0)
        // Legacy entry must remain so a retry can find it.
        expect(km.slots.get(LEGACY)?.secret).toBe('legacy_tok')
    })

    it('returns skipped(user-record-write-failed) when userRecords.upsert throws and leaves the legacy entry intact', async () => {
        const km = buildKeyringMap()
        km.slots.set(LEGACY, { secret: 'legacy_tok' })
        mockedCreateSecureStore.mockImplementation(km.create)
        const harness = buildUserRecords<Account>()
        harness.upsertSpy.mockRejectedValueOnce(new Error('disk full'))
        const marker = { migrated: false }

        const result = await migrateLegacyAuth<Account>({
            serviceName: SERVICE,
            legacyAccount: LEGACY,
            userRecords: harness.store,
            hasMigrated: async () => marker.migrated,
            markMigrated: async () => {
                marker.migrated = true
            },
            loadLegacyPlaintextToken: async () => null,
            identifyAccount: async () => ({ id: '99', email: 'me@x.io' }),
            silent: true,
        })

        expect(result).toMatchObject({ status: 'skipped', reason: 'user-record-write-failed' })
        // Legacy keyring entry is untouched so the next attempt can retry.
        expect(km.slots.get(LEGACY)?.secret).toBe('legacy_tok')
        // Marker is NOT set — otherwise the next run would short-circuit.
        expect(marker.migrated).toBe(false)
    })

    it('returns skipped(marker-write-failed) without touching the legacy slot when markMigrated throws', async () => {
        // The v2 record IS already written at this point, but the durable
        // gate isn't set. Surfacing `migrated` would let a later `logout`
        // open the door to re-migrating the still-present legacy token.
        const { km, state, result } = await runMigration({
            slots: { [LEGACY]: { secret: 'legacy_tok' } },
            marker: { migrated: false, markFails: new Error('config write blocked') },
            options: {
                identifyAccount: async () => ({ id: '42', email: 'a@b' }),
            },
        })

        expect(result).toMatchObject({ status: 'skipped', reason: 'marker-write-failed' })
        // v2 record is on disk; that's fine — the marker gate is what
        // keeps the next run from re-migrating.
        expect(state.records.has('42')).toBe(true)
        // Legacy entry preserved so the retry can find it.
        expect(km.slots.get(LEGACY)?.secret).toBe('legacy_tok')
    })

    it('still returns migrated when legacy cleanup fails (marker is the one-way gate, not cleanup)', async () => {
        const { result, marker } = await runMigration({
            slots: { [LEGACY]: { secret: 'legacy_tok', delErr: new Error('keyring busy') } },
            options: {
                identifyAccount: async () => ({ id: '42', email: 'a@b' }),
                cleanupLegacyConfig: async () => {
                    throw new Error('config cleanup blew up')
                },
            },
        })

        expect(result.status).toBe('migrated')
        expect(marker.migrated).toBe(true)
    })

    it('still returns migrated when cleanupLegacyConfig throws synchronously', async () => {
        // Without the `Promise.resolve().then(...)` wrapper a synchronous
        // throw escapes `Promise.allSettled` and makes the whole helper
        // reject — *after* the marker is already set.
        const { result } = await runMigration({
            slots: { [LEGACY]: { secret: 'legacy_tok' } },
            options: {
                identifyAccount: async () => ({ id: '42', email: 'a@b' }),
                cleanupLegacyConfig: (() => {
                    throw new Error('sync explosion')
                }) as unknown as () => Promise<void>,
            },
        })

        expect(result.status).toBe('migrated')
    })

    it('preserves an already-pinned defaultId across a successful migration', async () => {
        // Retry scenario: a previous run wrote the v2 record + setDefaultId
        // but `markMigrated` failed. Between then and now the user logged
        // in to a different account and picked it as the default. The
        // retry must not blindly promote the legacy account back.
        const otherAccount = { id: 'other', label: 'other', email: 'o@x' }
        const { state, result } = await runMigration({
            slots: { [LEGACY]: { secret: 'legacy_tok' } },
            seedRecords: { other: { account: otherAccount } },
            seedDefaultId: 'other',
            options: {
                identifyAccount: async () => ({ id: '42', email: 'a@b' }),
            },
        })

        expect(result.status).toBe('migrated')
        expect(state.records.has('42')).toBe(true)
        expect(state.defaultId).toBe('other')
    })

    it('writes to a custom keyring slot when accountForUser is overridden', async () => {
        const { km, result } = await runMigration({
            slots: { [LEGACY]: { secret: 'legacy_tok' } },
            options: {
                accountForUser: (id) => `custom-${id}`,
                identifyAccount: async () => ({ id: '99', email: 'me@x.io' }),
            },
        })

        expect(result.status).toBe('migrated')
        expect(km.slots.get('custom-99')?.secret).toBe('legacy_tok')
        expect(km.slots.get('user-99')?.secret).toBeUndefined()
    })

    it('prefers the legacy keyring token over the plaintext fallback when both are populated', async () => {
        // Locks the keyring-first precedence — a refactor that flipped the
        // order would silently surface a stale plaintext token even when a
        // freshly-rotated keyring credential exists.
        const { km, state, result } = await runMigration({
            slots: { [LEGACY]: { secret: 'fresh_keyring_tok' } },
            options: {
                loadLegacyPlaintextToken: async () => 'stale_plaintext_tok',
                identifyAccount: async (token) => {
                    expect(token).toBe('fresh_keyring_tok')
                    return { id: '7', email: 'p@l.x' }
                },
            },
        })

        expect(result.status).toBe('migrated')
        expect(km.slots.get('user-7')?.secret).toBe('fresh_keyring_tok')
        expect(state.records.get('7')?.fallbackToken).toBeUndefined()
    })
})

describe('migrateLegacyAuth — stderr privacy', () => {
    let consoleError: ReturnType<typeof vi.spyOn>
    beforeEach(() => {
        mockedCreateSecureStore.mockReset()
        consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    })
    afterEach(() => {
        consoleError.mockRestore()
    })

    it('the success line carries no account identifier (id/label/email may all be PII)', async () => {
        await runMigration({
            slots: { [LEGACY]: { secret: 'legacy_tok' } },
            options: {
                identifyAccount: async () => ({
                    id: 'sensitive-id@email.example',
                    label: 'sensitive@email.example',
                    email: 'sensitive@email.example',
                }),
                silent: false,
                logPrefix: 'td',
            },
        })

        const lines = consoleError.mock.calls.flat().join('\n')
        expect(lines).toContain('migrated existing token to multi-user store')
        expect(lines).not.toContain('sensitive')
    })

    it('uses atomic tryInsert when the consumer supplies it (no race on the existence check)', async () => {
        // Without `tryInsert`, the migration does list-then-upsert which
        // is racy: a parallel v2 login could complete between the two
        // calls and we'd clobber it. With `tryInsert`, the consumer
        // commits to an atomic check-and-insert and we trust their answer.
        const harness = buildUserRecords<Account>()
        // Stub tryInsert that ALSO actually inserts into the harness so
        // the migration's ownership-check re-reads see the placeholder.
        const tryInsert = vi.fn(async (record: UserRecord<Account>) => {
            if (harness.state.records.has(record.account.id)) return false
            harness.state.records.set(record.account.id, record)
            return true
        })
        harness.store.tryInsert = tryInsert
        const km = buildKeyringMap()
        km.slots.set(LEGACY, { secret: 'legacy_tok' })
        mockedCreateSecureStore.mockImplementation(km.create)

        const result = await migrateLegacyAuth<Account>({
            serviceName: SERVICE,
            legacyAccount: LEGACY,
            userRecords: harness.store,
            hasMigrated: async () => false,
            markMigrated: async () => {},
            loadLegacyPlaintextToken: async () => null,
            identifyAccount: async () => ({ id: '1', email: 'a@b' }),
            silent: true,
        })

        expect(result).toMatchObject({ status: 'migrated' })
        expect(tryInsert).toHaveBeenCalledTimes(1)
        // Placeholder uses a unique signature (`fallbackToken: legacyToken`
        // + `hasRefreshToken: undefined`) so the ownership-check re-read
        // can distinguish "still ours" from "v2 login took over". After
        // the keyring write succeeds the follow-up upsert flips
        // `hasRefreshToken` to `false`.
        expect(tryInsert.mock.calls[0][0]).toMatchObject({
            account: { id: '1' },
            fallbackToken: 'legacy_tok',
            hasRefreshToken: undefined,
        })
        // Access secret landed in the per-user slot.
        expect(km.slots.get('user-1')?.secret).toBe('legacy_tok')
        // Follow-up upsert flipped hasRefreshToken to false (so future
        // active() reads skip the refresh-slot IPC).
        expect(harness.state.records.get('1')?.hasRefreshToken).toBe(false)
    })

    it('keeps the plaintext fallback on the record when tryInsert succeeds but setSecret hits a keyring-offline error', async () => {
        // Two-phase write under contention with an offline keyring:
        // phase 1 (tryInsert with fallbackToken) succeeds, phase 2
        // (setSecret) throws SecureStoreUnavailableError. The migration
        // must NOT clear the fallback — that would leave a record with
        // no recoverable token. Subsequent migrations would see
        // `tryInsert: false` (record exists) and the CLI would surface
        // AUTH_STORE_READ_FAILED forever.
        const harness = buildUserRecords<Account>()
        const tryInsert = vi.fn(async (record: UserRecord<Account>) => {
            if (harness.state.records.has(record.account.id)) return false
            harness.state.records.set(record.account.id, record)
            return true
        })
        const upsertSpy = vi.fn(async (_record: UserRecord<Account>) => {})
        harness.store.tryInsert = tryInsert
        // Intercept upsert too so we can verify it isn't called to clear
        // the fallback (would happen on success).
        const originalUpsert = harness.store.upsert
        harness.store.upsert = async (record) => {
            await upsertSpy(record)
            return originalUpsert(record)
        }
        const km = buildKeyringMap()
        km.slots.set(LEGACY, { secret: 'legacy_tok' })
        km.slots.set('user-1', {
            secret: null,
            setErr: new SecureStoreUnavailableError('keyring down'),
        })
        mockedCreateSecureStore.mockImplementation(km.create)

        const result = await migrateLegacyAuth<Account>({
            serviceName: SERVICE,
            legacyAccount: LEGACY,
            userRecords: harness.store,
            hasMigrated: async () => false,
            markMigrated: async () => {},
            loadLegacyPlaintextToken: async () => null,
            identifyAccount: async () => ({ id: '1', email: 'a@b' }),
            silent: true,
        })

        expect(result).toMatchObject({ status: 'migrated' })
        // tryInsert was called with the plaintext fallback baked in
        // (placeholder signature: `fallbackToken: legacyToken` +
        // `hasRefreshToken: undefined`).
        expect(tryInsert.mock.calls[0][0]).toMatchObject({
            fallbackToken: 'legacy_tok',
            hasRefreshToken: undefined,
        })
        // The follow-up upsert (which would clear the fallback) never
        // ran because setSecret failed — the record keeps the fallback.
        expect(upsertSpy).not.toHaveBeenCalled()
    })

    it('aborts the keyring write when a concurrent v2 login replaces the placeholder mid-migration', async () => {
        // Simulates: tryInsert succeeds with our placeholder; then a v2
        // login completes (writes its own access token + record) before
        // we run our follow-up keyring writes. The ownership-check
        // re-read must detect the shape change and stop us from
        // clobbering the v2 state.
        const harness = buildUserRecords<Account>()
        const tryInsert = vi.fn(async (record: UserRecord<Account>) => {
            if (harness.state.records.has(record.account.id)) return false
            harness.state.records.set(record.account.id, record)
            // Race: as soon as our placeholder lands, a v2 login completes.
            // Replaces the record with its keyring-backed shape (no
            // fallbackToken, hasRefreshToken: true).
            harness.state.records.set(record.account.id, {
                account: { id: '1', email: 'a@b' },
                hasRefreshToken: true,
            })
            return true
        })
        harness.store.tryInsert = tryInsert
        const km = buildKeyringMap()
        km.slots.set(LEGACY, { secret: 'legacy_tok' })
        // V2 already wrote its access token to the keyring before our
        // migration's setSecret runs.
        km.slots.set('user-1', { secret: 'v2_access' })
        km.slots.set('user-1/refresh', { secret: 'v2_refresh' })
        mockedCreateSecureStore.mockImplementation(km.create)

        await migrateLegacyAuth<Account>({
            serviceName: SERVICE,
            legacyAccount: LEGACY,
            userRecords: harness.store,
            hasMigrated: async () => false,
            markMigrated: async () => {},
            loadLegacyPlaintextToken: async () => null,
            identifyAccount: async () => ({ id: '1', email: 'a@b' }),
            silent: true,
        })

        // V2's access token survives — our setSecret was skipped because
        // the ownership-check re-read saw the record had been replaced.
        expect(km.slots.get('user-1')?.secret).toBe('v2_access')
        // V2's refresh token survives too.
        expect(km.slots.get('user-1/refresh')?.secret).toBe('v2_refresh')
        // The v2 record is intact (hasRefreshToken: true, no fallback).
        expect(harness.state.records.get('1')).toMatchObject({
            hasRefreshToken: true,
        })
        expect(harness.state.records.get('1')?.fallbackToken).toBeUndefined()
    })

    it('leaves the v2 record alone when tryInsert returns false (existing v2 login)', async () => {
        // The whole point of routing through `tryInsert`: when a v2
        // login has already completed for the same account between
        // postinstall attempts, the migration is a no-op on the record
        // and never touches the per-user keyring slot. Without this guard
        // the legacy access-only bundle would clobber `hasRefreshToken` /
        // expiry on the v2 record.
        const tryInsert = vi.fn(async (_record: UserRecord<Account>) => false)
        const harness = buildUserRecords<Account>()
        // Pre-seed a v2 record with a refresh token to prove it survives.
        harness.state.records.set('1', {
            account: { id: '1', email: 'a@b' },
            hasRefreshToken: true,
            accessTokenExpiresAt: 99999,
        })
        harness.store.tryInsert = tryInsert
        const km = buildKeyringMap()
        km.slots.set(LEGACY, { secret: 'legacy_tok' })
        km.slots.set('user-1', { secret: 'v2_access_token' })
        km.slots.set('user-1/refresh', { secret: 'v2_refresh_token' })
        mockedCreateSecureStore.mockImplementation(km.create)

        await migrateLegacyAuth<Account>({
            serviceName: SERVICE,
            legacyAccount: LEGACY,
            userRecords: harness.store,
            hasMigrated: async () => false,
            markMigrated: async () => {},
            loadLegacyPlaintextToken: async () => null,
            identifyAccount: async () => ({ id: '1', email: 'a@b' }),
            silent: true,
        })

        // V2 record unchanged.
        expect(harness.state.records.get('1')).toMatchObject({
            hasRefreshToken: true,
            accessTokenExpiresAt: 99999,
        })
        // Per-user keyring slots untouched — the legacy access token
        // never overwrote v2's.
        expect(km.slots.get('user-1')?.secret).toBe('v2_access_token')
        expect(km.slots.get('user-1/refresh')?.secret).toBe('v2_refresh_token')
    })

    it('the skip line is generic and does not echo the raw exception text', async () => {
        const { result } = await runMigration({
            slots: { [LEGACY]: { secret: 'legacy_tok' } },
            options: {
                identifyAccount: async () => {
                    throw new Error('email leak: sensitive@email.example at /Users/me/.config/x')
                },
                silent: false,
                logPrefix: 'td',
            },
        })

        expect(result.status).toBe('skipped')
        const lines = consoleError.mock.calls.flat().join('\n')
        expect(lines).toContain('could not identify user')
        expect(lines).not.toContain('sensitive@email.example')
        expect(lines).not.toContain('/Users/me/.config/x')
        // The raw detail is preserved on the result for in-process callers.
        if (result.status === 'skipped') {
            expect(result.detail).toContain('sensitive@email.example')
        }
    })
})
