import { beforeEach, describe, expect, it, vi } from 'vitest'

const keyringMocks = vi.hoisted(() => {
    const entry = {
        getPassword: vi.fn(),
        setPassword: vi.fn(),
        deleteCredential: vi.fn(),
    }
    // Toggle the getter on the mocked module reads on each property access,
    // so a single test can simulate a missing native binary by flipping this
    // boolean without `vi.doUnmock` (which would leave the real keyring
    // exposed to subsequent tests).
    const state = { throwOnImport: false }
    return {
        AsyncEntry: vi.fn().mockImplementation(function AsyncEntry() {
            return entry
        }),
        entry,
        state,
    }
})

// `AsyncEntry` is read via a getter so we can throw on access, which is what
// `@napi-rs/keyring` does when the prebuilt native binary is missing for the
// current arch. A plain factory would only run once per file and couldn't
// vary per test.
vi.mock('@napi-rs/keyring', () => ({
    get AsyncEntry() {
        if (keyringMocks.state.throwOnImport) {
            throw new Error('no native binary for this arch')
        }
        return keyringMocks.AsyncEntry
    },
}))

const SERVICE = 'cli-core-test'
const ACCOUNT = 'user-42'

describe('createSecureStore', () => {
    beforeEach(() => {
        // `mockReset` (not `clearAllMocks`) so the resolved/rejected values
        // set by `mockResolvedValueOnce` etc. don't leak between tests and
        // make this suite order-dependent. The `AsyncEntry` constructor
        // mock is left untouched so `new AsyncEntry()` still returns `entry`.
        keyringMocks.entry.getPassword.mockReset()
        keyringMocks.entry.setPassword.mockReset()
        keyringMocks.entry.deleteCredential.mockReset()
        keyringMocks.AsyncEntry.mockClear()
        vi.resetModules()
        keyringMocks.state.throwOnImport = false
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

    it('resolves to null when the keyring has no credential for the slot', async () => {
        keyringMocks.entry.getPassword.mockResolvedValue(null)

        const { createSecureStore } = await import('./secure-store.js')

        await expect(
            createSecureStore({ serviceName: SERVICE, account: ACCOUNT }).getSecret(),
        ).resolves.toBeNull()
    })

    it.each([
        ['getSecret', () => keyringMocks.entry.getPassword] as const,
        ['setSecret', () => keyringMocks.entry.setPassword] as const,
        ['deleteSecret', () => keyringMocks.entry.deleteCredential] as const,
    ])(
        'wraps a %s keyring failure as SecureStoreUnavailableError and preserves cause',
        async (method, pickSpy) => {
            const cause = new Error(`backend down (${method})`)
            pickSpy().mockRejectedValueOnce(cause)

            const { createSecureStore, SecureStoreUnavailableError } =
                await import('./secure-store.js')
            const store = createSecureStore({ serviceName: SERVICE, account: ACCOUNT })

            const invoke = async () => {
                if (method === 'getSecret') return store.getSecret()
                if (method === 'setSecret') return store.setSecret('x')
                return store.deleteSecret()
            }
            const error = await invoke().then(
                () => undefined,
                (rejection: unknown) => rejection,
            )
            expect(error).toBeInstanceOf(SecureStoreUnavailableError)
            expect((error as Error).message).toContain(`backend down (${method})`)
            expect((error as { cause?: unknown }).cause).toBe(cause)
        },
    )

    it('memoises the AsyncEntry across calls on the same store', async () => {
        keyringMocks.entry.getPassword.mockResolvedValue('tok')

        const { createSecureStore } = await import('./secure-store.js')
        const store = createSecureStore({ serviceName: SERVICE, account: ACCOUNT })

        await store.getSecret()
        await store.getSecret()
        await store.deleteSecret()

        expect(keyringMocks.AsyncEntry).toHaveBeenCalledTimes(1)
    })

    it('surfaces an import failure as SecureStoreUnavailableError and memoises the rejection (no retry on later calls)', async () => {
        keyringMocks.state.throwOnImport = true

        const { createSecureStore, SecureStoreUnavailableError } = await import('./secure-store.js')
        const store = createSecureStore({ serviceName: SERVICE, account: ACCOUNT })

        await expect(store.getSecret()).rejects.toBeInstanceOf(SecureStoreUnavailableError)

        // Flip the toggle back on so a re-import would now succeed — the
        // store's memoised `entryPromise` should still replay the original
        // rejection and the import factory should not be re-evaluated.
        keyringMocks.state.throwOnImport = false
        await expect(store.getSecret()).rejects.toBeInstanceOf(SecureStoreUnavailableError)
        expect(keyringMocks.AsyncEntry).not.toHaveBeenCalled()
    })
})
