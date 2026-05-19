import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
    buildKeyringMap,
    buildUserRecords,
    type UserRecordsHarness,
} from '../../test-support/keyring-mocks.js'
import { migrateLegacyAuth, type MigrateLegacyAuthOptions } from './migrate.js'
import { SecureStoreUnavailableError } from './secure-store.js'
import type { UserRecord } from './types.js'

/**
 * Stub `tryInsert` for a harness so that successful inserts actually land
 * in the harness state — the migration's ownership-check re-reads need to
 * see the placeholder. Returns the spy so tests can assert call args and
 * (optionally) that the legacy fallback `list()` path was avoided.
 */
function stubTryInsert(
    harness: UserRecordsHarness<Account>,
): ReturnType<typeof vi.fn<(record: UserRecord<Account>) => Promise<boolean>>> {
    const spy = vi.fn(async (record: UserRecord<Account>) => {
        if (harness.state.records.has(record.account.id)) return false
        harness.state.records.set(record.account.id, record)
        return true
    })
    harness.store.tryInsert = spy
    return spy
}

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

    it('migrates a legacy keyring token to a v2 record carrying it as fallbackToken', async () => {
        // Migration deliberately writes the legacy token to the v2
        // record's `fallbackToken` field (a valid v2 state — the
        // runtime reads it before any keyring slot) rather than moving
        // the secret into the per-user keyring slot itself. The slot
        // move happens later, atomically, on the next v2 login via
        // `writeRecordWithKeyringFallback`. Earlier revisions tried to
        // do the move here and accumulated a chain of races; the
        // simplification trades "secret in keyring immediately" for
        // complete race-freedom.
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
        // Per-user keyring slot is NEVER written during migration.
        expect(km.slots.has('user-99')).toBe(false)
        // Legacy slot is cleared post-success.
        expect(km.slots.get(LEGACY)?.secret).toBeNull()
        // Record carries the legacy token as fallbackToken.
        expect(state.records.get('99')?.fallbackToken).toBe('legacy_tok')
        expect(state.records.get('99')?.hasRefreshToken).toBe(false)
        expect(state.defaultId).toBe('99')
        expect(harness.upsertSpy).toHaveBeenCalledTimes(1)
        expect(cleanup).toHaveBeenCalledTimes(1)
        expect(markMigrated).toHaveBeenCalledTimes(1)
        expect(marker.migrated).toBe(true)
    })

    it('falls back to loadLegacyPlaintextToken when the legacy keyring slot is empty', async () => {
        const { state, result } = await runMigration({
            options: {
                loadLegacyPlaintextToken: async () => 'plain_legacy',
                identifyAccount: async () => ({ id: '7', email: 'p@l.x' }),
            },
        })

        expect(result.status).toBe('migrated')
        expect(state.records.get('7')?.fallbackToken).toBe('plain_legacy')
    })

    it('migrates against an entirely offline keyring when the plaintext slot has the token (WSL/headless)', async () => {
        // The keyring is dead: reading the legacy slot throws. Migration
        // sources the token from the consumer's plaintext slot and
        // parks it on the user record as `fallbackToken`. With the
        // simplified migration (no per-user keyring writes), the
        // per-user slot's keyring status doesn't matter — migration
        // never touches it.
        const { state, result } = await runMigration({
            slots: {
                [LEGACY]: { getErr: new SecureStoreUnavailableError('no dbus') },
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

    it('honours the deprecated accountForUser option as a no-op (legacy migration writes no per-user keyring slot)', async () => {
        // `accountForUser` was load-bearing when migration moved the
        // secret into a per-user keyring slot. With the simplified
        // migration (no per-user keyring writes), the option is a no-op
        // — kept on the type for back-compat. This test pins that:
        // passing a custom slug must NOT write any per-user keyring
        // entry under either the default or custom name.
        const { km, state, result } = await runMigration({
            slots: { [LEGACY]: { secret: 'legacy_tok' } },
            options: {
                accountForUser: (id) => `custom-${id}`,
                identifyAccount: async () => ({ id: '99', email: 'me@x.io' }),
            },
        })

        expect(result.status).toBe('migrated')
        expect(km.slots.has('custom-99')).toBe(false)
        expect(km.slots.has('user-99')).toBe(false)
        // Record still carries the legacy token as fallback.
        expect(state.records.get('99')?.fallbackToken).toBe('legacy_tok')
    })

    it('prefers the legacy keyring token over the plaintext fallback when both are populated', async () => {
        // Locks the keyring-first precedence — a refactor that flipped the
        // order would silently surface a stale plaintext token even when a
        // freshly-rotated keyring credential exists.
        const { state, result } = await runMigration({
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
        expect(state.records.get('7')?.fallbackToken).toBe('fresh_keyring_tok')
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

    it('uses atomic tryInsert when the consumer supplies it (race-free)', async () => {
        // Without `tryInsert`, the migration does list-then-upsert which
        // has a small race window with parallel v2 logins. With
        // `tryInsert`, the consumer commits to an atomic
        // check-and-insert and we delegate the existence decision to
        // them entirely. No keyring writes from migration, no follow-up
        // upserts — the simplification eliminates the multi-step race
        // surface that earlier revisions kept introducing.
        const harness = buildUserRecords<Account>()
        const tryInsert = stubTryInsert(harness)
        const upsertSpy = vi.spyOn(harness.store, 'upsert')
        const listSpy = vi.spyOn(harness.store, 'list')
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
        expect(tryInsert.mock.calls[0][0]).toMatchObject({
            account: { id: '1' },
            fallbackToken: 'legacy_tok',
            hasRefreshToken: false,
        })
        // Per-user keyring slot is NEVER written during migration. The
        // first subsequent v2 login moves the secret atomically via
        // `writeRecordWithKeyringFallback`.
        expect(km.slots.has('user-1')).toBe(false)
        expect(km.slots.has('user-1/refresh')).toBe(false)
        // No follow-up upsert: tryInsert is the only record write the
        // migration does. Confirms the absence of the "upsert clobbers
        // a parallel v2 login mid-migration" race surface.
        expect(upsertSpy).not.toHaveBeenCalled()
        // The racy `list()`-then-check existence path is bypassed
        // entirely when `tryInsert` is available.
        expect(listSpy).not.toHaveBeenCalled()
    })

    it('survives a concurrent v2 login mid-migration (race-free property)', async () => {
        // The end-to-end race property: if a v2 login lands between the
        // legacy token discovery and our tryInsert, neither side's
        // state is clobbered. tryInsert either:
        //   (a) succeeds, because v2 hasn't written its record yet —
        //       migration's fallbackToken record is the only state, and
        //       v2's next setBundle replaces it atomically; or
        //   (b) returns false, because v2 already wrote its record —
        //       migration is a no-op and v2's state is untouched.
        // Either way, no keyring writes happen from migration, so v2's
        // access/refresh slots are guaranteed-safe across this race.
        const harness = buildUserRecords<Account>()
        // tryInsert mock that mimics v2 having JUST won the race —
        // record already present (with refresh metadata).
        harness.state.records.set('1', {
            account: { id: '1', email: 'a@b' },
            hasRefreshToken: true,
            accessTokenExpiresAt: 99_999,
        })
        const tryInsert = stubTryInsert(harness)
        const km = buildKeyringMap()
        km.slots.set(LEGACY, { secret: 'legacy_tok' })
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

        // tryInsert returned false (v2 record was already there) → no
        // record change.
        expect(tryInsert).toHaveBeenCalledTimes(1)
        expect(harness.state.records.get('1')).toMatchObject({
            hasRefreshToken: true,
            accessTokenExpiresAt: 99_999,
        })
        // Keyring slots untouched.
        expect(km.slots.get('user-1')?.secret).toBe('v2_access')
        expect(km.slots.get('user-1/refresh')?.secret).toBe('v2_refresh')
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
