import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { buildKeyringMap, buildUserRecords } from '../../test-support/keyring-mocks.js'
import { migrateLegacyAuth } from './migrate.js'
import { SecureStoreUnavailableError } from './secure-store.js'

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

describe('migrateLegacyAuth', () => {
    beforeEach(() => {
        mockedCreateSecureStore.mockReset()
    })

    it('returns already-migrated when user records already exist', async () => {
        // No keyring mock needed — `migrateLegacyAuth` returns before ever calling `createSecureStore`.
        const { store: userRecords, state } = buildUserRecords<Account>()
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
        expect(mockedCreateSecureStore).not.toHaveBeenCalled()
    })

    it('returns no-legacy-state when neither slot has a token', async () => {
        const km = buildKeyringMap()
        mockedCreateSecureStore.mockImplementation(km.create)
        const { store: userRecords } = buildUserRecords<Account>()

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
        const { store: userRecords, state, upsertSpy } = buildUserRecords<Account>()
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
        const { store: userRecords, state } = buildUserRecords<Account>()

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
        const { store: userRecords, state } = buildUserRecords<Account>()

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

    it('returns skipped when identifyAccount throws', async () => {
        const km = buildKeyringMap()
        km.slots.set(LEGACY, { secret: 'legacy_tok' })
        mockedCreateSecureStore.mockImplementation(km.create)
        const { store: userRecords, state } = buildUserRecords<Account>()

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

    it('the success line carries only account.id (no label/email)', async () => {
        const km = buildKeyringMap()
        km.slots.set(LEGACY, { secret: 'legacy_tok' })
        mockedCreateSecureStore.mockImplementation(km.create)
        const { store: userRecords } = buildUserRecords<Account>()

        await migrateLegacyAuth<Account>({
            serviceName: SERVICE,
            legacyAccount: LEGACY,
            userRecords,
            loadLegacyPlaintextToken: async () => null,
            identifyAccount: async () => ({
                id: 'user-99',
                label: 'sensitive@email.example',
                email: 'sensitive@email.example',
            }),
            silent: false,
            logPrefix: 'td',
        })

        const lines = consoleError.mock.calls.flat().join('\n')
        expect(lines).toContain('user-99')
        expect(lines).not.toContain('sensitive@email.example')
    })

    it('the skip line is generic and does not echo the raw exception text', async () => {
        const km = buildKeyringMap()
        km.slots.set(LEGACY, { secret: 'legacy_tok' })
        mockedCreateSecureStore.mockImplementation(km.create)
        const { store: userRecords } = buildUserRecords<Account>()

        const result = await migrateLegacyAuth<Account>({
            serviceName: SERVICE,
            legacyAccount: LEGACY,
            userRecords,
            loadLegacyPlaintextToken: async () => null,
            identifyAccount: async () => {
                throw new Error('email leak: sensitive@email.example at /Users/me/.config/x')
            },
            silent: false,
            logPrefix: 'td',
        })

        expect(result.status).toBe('skipped')
        const lines = consoleError.mock.calls.flat().join('\n')
        expect(lines).toContain('could not identify user')
        expect(lines).not.toContain('sensitive@email.example')
        expect(lines).not.toContain('/Users/me/.config/x')
        // The raw detail is preserved on the result for in-process callers.
        expect(result.reason).toContain('sensitive@email.example')
    })
})
