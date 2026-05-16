import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const keyringMocks = vi.hoisted(() => {
    const entry = {
        getPassword: vi.fn(),
        setPassword: vi.fn(),
        deleteCredential: vi.fn(),
    }
    return {
        AsyncEntry: vi.fn().mockImplementation(function AsyncEntry() {
            return entry
        }),
        entry,
    }
})

vi.mock('@napi-rs/keyring', () => ({
    AsyncEntry: keyringMocks.AsyncEntry,
}))

const SERVICE = 'cli-core-test'
const ACCOUNT = 'user-42'

describe('createSecureStore', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        vi.resetModules()
    })

    it('reads, writes, and deletes secrets via @napi-rs/keyring with the configured service/account', async () => {
        keyringMocks.entry.getPassword.mockResolvedValue('tok_abcdef')
        keyringMocks.entry.setPassword.mockResolvedValue(undefined)
        keyringMocks.entry.deleteCredential.mockResolvedValue(true)

        const { createSecureStore } = await import('./secure-store.js')
        const store = createSecureStore({ serviceName: SERVICE, account: ACCOUNT })

        await expect(store.getSecret()).resolves.toBe('tok_abcdef')
        await expect(store.setSecret('tok_abcdef')).resolves.toBeUndefined()
        await expect(store.deleteSecret()).resolves.toBe(true)

        expect(keyringMocks.AsyncEntry).toHaveBeenCalledWith(SERVICE, ACCOUNT)
        expect(keyringMocks.entry.setPassword).toHaveBeenCalledWith('tok_abcdef')
    })

    it('returns null when the keyring has no entry for the slot', async () => {
        keyringMocks.entry.getPassword.mockResolvedValue(null)

        const { createSecureStore } = await import('./secure-store.js')
        const store = createSecureStore({ serviceName: SERVICE, account: ACCOUNT })

        await expect(store.getSecret()).resolves.toBeNull()
    })

    it('wraps a get failure as SecureStoreUnavailableError', async () => {
        keyringMocks.entry.getPassword.mockRejectedValue(new Error('Keychain locked'))

        const { createSecureStore, SecureStoreUnavailableError } = await import('./secure-store.js')

        await expect(
            createSecureStore({ serviceName: SERVICE, account: ACCOUNT }).getSecret(),
        ).rejects.toBeInstanceOf(SecureStoreUnavailableError)
    })

    it('wraps a set failure as SecureStoreUnavailableError', async () => {
        keyringMocks.entry.setPassword.mockRejectedValue(new Error('libsecret missing'))

        const { createSecureStore, SecureStoreUnavailableError } = await import('./secure-store.js')

        await expect(
            createSecureStore({ serviceName: SERVICE, account: ACCOUNT }).setSecret('x'),
        ).rejects.toBeInstanceOf(SecureStoreUnavailableError)
    })

    it('wraps a delete failure as SecureStoreUnavailableError', async () => {
        keyringMocks.entry.deleteCredential.mockRejectedValue(new Error('D-Bus down'))

        const { createSecureStore, SecureStoreUnavailableError } = await import('./secure-store.js')

        await expect(
            createSecureStore({ serviceName: SERVICE, account: ACCOUNT }).deleteSecret(),
        ).rejects.toBeInstanceOf(SecureStoreUnavailableError)
    })
})

describe('createSecureStore — missing native binary', () => {
    beforeEach(() => {
        vi.resetModules()
    })

    // Ensure the throw-on-import mock is torn down even when the assertion
    // inside the `it` body fails. Inline cleanup would otherwise be skipped
    // and leave the mock active for later tests.
    afterEach(() => {
        vi.doUnmock('@napi-rs/keyring')
    })

    it('surfaces an import failure as SecureStoreUnavailableError instead of crashing module load', async () => {
        vi.doMock('@napi-rs/keyring', () => {
            throw new Error('no native binary for this arch')
        })

        const { createSecureStore, SecureStoreUnavailableError } = await import('./secure-store.js')

        await expect(
            createSecureStore({ serviceName: SERVICE, account: ACCOUNT }).getSecret(),
        ).rejects.toBeInstanceOf(SecureStoreUnavailableError)
    })
})
