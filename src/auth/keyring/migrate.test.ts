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
        /** Opt the harness into the atomic `tryInsert?` path. */
        withTryInsert?: boolean
        options?: Partial<MigrateLegacyAuthOptions<Account>>
    } = {},
) {
    const km = buildKeyringMap()
    for (const [slug, slot] of Object.entries(opts.slots ?? {})) {
        km.slots.set(slug, { secret: null, ...slot })
    }
    mockedCreateSecureStore.mockImplementation(km.create)

    const harness = buildUserRecords<Account>({ withTryInsert: opts.withTryInsert })
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
        const { km, state, result, marker, markMigrated } = await runMigration({
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

    it('uses tryInsert (atomic) and never calls list() when the store implements it', async () => {
        // Atomic path must avoid the list-then-upsert TOCTOU race entirely.
        const { km, harness, result } = await runMigration({
            slots: { [LEGACY]: { secret: 'legacy_tok' } },
            withTryInsert: true,
            options: {
                identifyAccount: async () => ({ id: '99', email: 'me@x.io' }),
            },
        })

        expect(result.status).toBe('migrated')
        expect(harness.tryInsertSpy).toHaveBeenCalledTimes(1)
        // Phase 2 promotes the record to the clean (no-fallback) shape.
        expect(harness.upsertSpy).toHaveBeenCalledTimes(1)
        // Atomic insert means `list()` is never consulted on Phase 1.
        expect(harness.listSpy).not.toHaveBeenCalled()
        expect(km.slots.get('user-99')?.secret).toBe('legacy_tok')
    })

    it.each([true, false])(
        'skips Phase 2 when a v2 record already exists (withTryInsert=%s)',
        async (withTryInsert) => {
            const existing: UserRecord<Account> = {
                account: { id: '99', email: 'me@x.io', label: 'updated-label' },
                hasRefreshToken: false,
            }
            const { km, state, result, marker, harness } = await runMigration({
                slots: {
                    [LEGACY]: { secret: 'legacy_tok' },
                    'user-99': { secret: 'fresh_login_tok' },
                },
                seedRecords: { '99': existing },
                withTryInsert,
                options: {
                    identifyAccount: async () => ({ id: '99', email: 'me@x.io' }),
                },
            })

            expect(result.status).toBe('migrated')
            expect(harness.upsertSpy).not.toHaveBeenCalled()
            expect(state.records.get('99')).toBe(existing)
            expect(km.slots.get('user-99')?.secret).toBe('fresh_login_tok')
            expect(km.slots.get(LEGACY)?.secret).toBeNull()
            expect(marker.migrated).toBe(true)
        },
    )

    it('returns skipped(user-keyring-unreachable) when an existing v2 record cannot be read', async () => {
        // A clean v2 record from a prior set/setBundle has no fallbackToken
        // and depends on the keyring being reachable. With the keyring
        // offline, cleaning up the legacy state would brick the user — we
        // must abort the migration and leave the legacy token in place.
        const existing: UserRecord<Account> = {
            account: { id: '99', email: 'me@x.io' },
            hasRefreshToken: false,
        }
        const { km, state, result, marker } = await runMigration({
            slots: {
                [LEGACY]: { secret: 'legacy_tok' },
                'user-99': { getErr: new SecureStoreUnavailableError('no dbus') },
            },
            seedRecords: { '99': existing },
            options: {
                identifyAccount: async () => ({ id: '99', email: 'me@x.io' }),
            },
        })

        expect(result).toMatchObject({
            status: 'skipped',
            reason: 'user-keyring-unreachable',
        })
        expect(marker.migrated).toBe(false)
        expect(km.slots.get(LEGACY)?.secret).toBe('legacy_tok')
        expect(state.records.get('99')).toBe(existing)
    })

    it('returns skipped(user-record-write-failed) when an existing v2 record has empty fallback AND empty slot', async () => {
        // Corrupted state: the record carries no plaintext fallback and
        // the per-user keyring slot is empty (deleted out of band). We
        // must NOT cleanup legacy — the user has no readable credential.
        const existing: UserRecord<Account> = {
            account: { id: '99', email: 'me@x.io' },
            hasRefreshToken: false,
        }
        const { km, state, result, marker } = await runMigration({
            slots: {
                [LEGACY]: { secret: 'legacy_tok' },
                // No `secret` and no `getErr` → getSecret returns null.
                'user-99': {},
            },
            seedRecords: { '99': existing },
            options: {
                identifyAccount: async () => ({ id: '99', email: 'me@x.io' }),
            },
        })

        expect(result).toMatchObject({
            status: 'skipped',
            reason: 'user-record-write-failed',
        })
        expect(marker.migrated).toBe(false)
        expect(km.slots.get(LEGACY)?.secret).toBe('legacy_tok')
        expect(state.records.get('99')).toBe(existing)
    })

    it('skips the readability check when an existing v2 record carries an external fallbackToken', async () => {
        // External record's fallback differs from the legacy token → not a
        // prior-run Phase 1 → don't attempt Phase 2. The fallback alone
        // makes the record readable, so the per-user slot is never probed.
        const existing: UserRecord<Account> = {
            account: { id: '99', email: 'me@x.io' },
            fallbackToken: 'external_plaintext',
            hasRefreshToken: false,
        }
        const { km, result, marker } = await runMigration({
            slots: {
                [LEGACY]: { secret: 'legacy_tok' },
                'user-99': { getErr: new SecureStoreUnavailableError('no dbus') },
            },
            seedRecords: { '99': existing },
            options: {
                identifyAccount: async () => ({ id: '99', email: 'me@x.io' }),
            },
        })

        expect(result.status).toBe('migrated')
        expect(marker.migrated).toBe(true)
        expect(km.slots.get(LEGACY)?.secret).toBeNull()
        // Per-user slot must NEVER have been read — the fallback short-circuits.
        expect(km.getCalls.has('user-99')).toBe(false)
    })

    it('retries Phase 2 when the existing record carries our legacy token (prior incomplete migration)', async () => {
        // Scenario: a previous run wrote the Phase 1 fallback record but
        // Phase 2 failed (transient backend error). Marker stayed unset.
        // On retry, the existence check finds the record, recognises the
        // fallback token as our own legacy token, and finishes Phase 2.
        const existing: UserRecord<Account> = {
            account: { id: '99', email: 'me@x.io' },
            fallbackToken: 'legacy_tok',
            hasRefreshToken: false,
        }
        const { km, state, result, marker, harness } = await runMigration({
            slots: { [LEGACY]: { secret: 'legacy_tok' } },
            seedRecords: { '99': existing },
            options: {
                identifyAccount: async () => ({ id: '99', email: 'me@x.io' }),
            },
        })

        expect(result.status).toBe('migrated')
        expect(km.slots.get('user-99')?.secret).toBe('legacy_tok')
        expect(state.records.get('99')?.fallbackToken).toBeUndefined()
        expect(marker.migrated).toBe(true)
        // Phase 2 ran exactly once: setSecret + clean upsert.
        expect(harness.upsertSpy).toHaveBeenCalledTimes(1)
    })

    it('Phase 2 SecureStoreUnavailable falls back silently; Phase 1 record survives', async () => {
        // Headless / WSL: the per-user slot can't accept a write. Phase 1's
        // fallback record is self-sufficient, so the migration completes
        // with the token in plaintext (until a future login upgrades it).
        const { km, state, result, marker } = await runMigration({
            slots: {
                [LEGACY]: { secret: 'legacy_tok' },
                'user-99': { setErr: new SecureStoreUnavailableError('no dbus') },
            },
            options: {
                identifyAccount: async () => ({ id: '99', email: 'me@x.io' }),
            },
        })

        expect(result.status).toBe('migrated')
        expect(state.records.get('99')?.fallbackToken).toBe('legacy_tok')
        expect(km.slots.get('user-99')?.secret).toBeNull()
        expect(marker.migrated).toBe(true)
        expect(km.slots.get(LEGACY)?.secret).toBeNull()
    })

    it('Phase 2 non-keyring setSecret failure surfaces as skipped (marker stays unset)', async () => {
        // A transient backend error must not be silently swallowed — the
        // operator needs visibility, and the marker stays unset so a future
        // retry can re-attempt Phase 2.
        const { result, marker, km } = await runMigration({
            slots: {
                [LEGACY]: { secret: 'legacy_tok' },
                'user-99': { setErr: new Error('keyring backend exploded') },
            },
            options: {
                identifyAccount: async () => ({ id: '99', email: 'me@x.io' }),
            },
        })

        expect(result).toMatchObject({
            status: 'skipped',
            reason: 'user-record-write-failed',
        })
        expect(marker.migrated).toBe(false)
        expect(km.slots.get(LEGACY)?.secret).toBe('legacy_tok')
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
