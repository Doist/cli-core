import { describe, expect, it, vi } from 'vitest'

import { runOAuthFlow } from './flow.js'
import type { AuthProvider, TokenStore } from './types.js'

type Account = { id: string; label?: string; email: string }

/** Tiny in-memory `TokenStore` so the flow tests don't need disk I/O. */
function fakeStore(): TokenStore<Account> & { last?: { account: Account; token: string } } {
    const state: { last?: { account: Account; token: string } } = {}
    return {
        async active() {
            return state.last ?? null
        },
        async set(account, token) {
            state.last = { account, token }
        },
        async clear() {
            state.last = undefined
        },
        get last() {
            return state.last
        },
    }
}

const renderSuccess = () => '<html>ok</html>'
const renderError = () => '<html>err</html>'

/**
 * Build a provider that records the runtime-assigned redirectUri so the
 * caller's `openBrowser` mock can drive the callback against the actual
 * server port (rather than guessing a hardcoded one).
 *
 * Caller-supplied `authorize` overrides are wrapped, not replaced, so the
 * redirectUri capture survives.
 */
function instrument(provider: Partial<AuthProvider<Account>> = {}): {
    provider: AuthProvider<Account>
    getRedirect: () => string
} {
    let redirectUri = ''
    const defaultAuthorize: AuthProvider<Account>['authorize'] = async (input) => ({
        authorizeUrl: `https://example.com/oauth/authorize?state=${input.state}`,
        handshake: { codeVerifier: 'v1' },
    })
    const innerAuthorize: AuthProvider<Account>['authorize'] =
        provider.authorize ?? defaultAuthorize
    const { authorize: _drop, ...rest } = provider
    void _drop
    const wrapped: AuthProvider<Account> = {
        async exchangeCode() {
            return { accessToken: 'tok-1' }
        },
        async validateToken() {
            return { id: '1', email: 'a@b' }
        },
        ...rest,
        async authorize(input) {
            redirectUri = input.redirectUri
            return innerAuthorize(input)
        },
    }
    return { provider: wrapped, getRedirect: () => redirectUri }
}

describe('runOAuthFlow', () => {
    it('drives prepare → authorize → exchange → validate → store and returns the result', async () => {
        const prepare = vi.fn(async () => ({ handshake: { dcrSecret: 'shh' } }))
        const exchangeCode = vi.fn(async () => ({ accessToken: 'tok-1' }))
        const validateToken = vi.fn(async () => ({ id: '1', email: 'a@b' }))
        const { provider, getRedirect } = instrument({ prepare, exchangeCode, validateToken })
        const store = fakeStore()

        const openBrowser = vi.fn(async (url: string) => {
            const state = new URL(url).searchParams.get('state') ?? ''
            await fetch(`${getRedirect()}?code=abc&state=${state}`)
        })

        const result = await runOAuthFlow<Account>({
            provider,
            store,
            scopes: ['read'],
            readOnly: false,
            flags: {},
            preferredPort: 0,
            renderSuccess,
            renderError,
            openBrowser,
            onAuthorizeUrl: () => undefined,
            timeoutMs: 5000,
        })

        expect(result.token).toBe('tok-1')
        expect(result.account).toEqual({ id: '1', email: 'a@b' })
        expect(prepare).toHaveBeenCalledTimes(1)
        expect(exchangeCode).toHaveBeenCalledTimes(1)
        expect(validateToken).toHaveBeenCalledTimes(1)
        expect(openBrowser).toHaveBeenCalledTimes(1)
        expect(await store.active()).toEqual({
            token: 'tok-1',
            account: { id: '1', email: 'a@b' },
        })
    })

    it('skips validateToken when exchangeCode returns an account', async () => {
        const validateToken = vi.fn(async () => ({ id: 'WRONG', email: 'x@x' }))
        const { provider, getRedirect } = instrument({
            exchangeCode: async () => ({
                accessToken: 'tok-1',
                account: { id: '99', email: 'right@b' },
            }),
            validateToken,
        })
        const store = fakeStore()

        const result = await runOAuthFlow<Account>({
            provider,
            store,
            scopes: [],
            readOnly: false,
            flags: {},
            preferredPort: 0,
            renderSuccess,
            renderError,
            openBrowser: async (url) => {
                const state = new URL(url).searchParams.get('state') ?? ''
                await fetch(`${getRedirect()}?code=abc&state=${state}`)
            },
            timeoutMs: 5000,
        })
        expect(result.account.id).toBe('99')
        expect(validateToken).not.toHaveBeenCalled()
    })

    it('threads prepare-time handshake into validateToken even when authorize forgets to forward it', async () => {
        const validateToken = vi.fn(async ({ handshake }) => {
            expect(handshake.dcrSecret).toBe('shh') // came from prepare(), not authorize()
            return { id: '1', email: 'a@b' }
        })
        const { provider, getRedirect } = instrument({
            prepare: async () => ({ handshake: { dcrSecret: 'shh' } }),
            // authorize deliberately drops the prepare handshake — runOAuthFlow
            // must merge it back in for downstream methods.
            authorize: async (input) => ({
                authorizeUrl: `https://example.com/oauth/authorize?state=${input.state}`,
                handshake: { codeVerifier: 'v1' },
            }),
            validateToken,
        })
        const store = fakeStore()

        await runOAuthFlow<Account>({
            provider,
            store,
            scopes: [],
            readOnly: false,
            flags: {},
            preferredPort: 0,
            renderSuccess,
            renderError,
            openBrowser: async (url) => {
                const state = new URL(url).searchParams.get('state') ?? ''
                await fetch(`${getRedirect()}?code=abc&state=${state}`)
            },
            timeoutMs: 5000,
        })
        expect(validateToken).toHaveBeenCalledTimes(1)
    })

    it('rejects with AUTH_CALLBACK_TIMEOUT when no callback arrives', async () => {
        const { provider } = instrument()
        const store = fakeStore()
        await expect(
            runOAuthFlow<Account>({
                provider,
                store,
                scopes: [],
                readOnly: false,
                flags: {},
                preferredPort: 0,
                renderSuccess,
                renderError,
                openBrowser: async () => {}, // never triggers a callback
                timeoutMs: 50,
            }),
        ).rejects.toMatchObject({ code: 'AUTH_CALLBACK_TIMEOUT' })
    })

    it('keeps the callback server listening on bad-shape requests; resolves on the eventual valid one', async () => {
        const { provider, getRedirect } = instrument()
        const store = fakeStore()

        const result = await runOAuthFlow<Account>({
            provider,
            store,
            scopes: [],
            readOnly: false,
            flags: {},
            preferredPort: 0,
            renderSuccess,
            renderError,
            openBrowser: async (url) => {
                const state = new URL(url).searchParams.get('state') ?? ''
                // Spurious requests (browser-extension prefetch, accidental
                // reload) that don't match the expected state should leave the
                // server listening rather than killing the in-flight flow.
                const bad1 = await fetch(`${getRedirect()}?code=abc&state=wrong`)
                expect(bad1.status).toBe(400)
                const bad2 = await fetch(`${getRedirect()}?code=abc`)
                expect(bad2.status).toBe(400)
                // The legitimate redirect arriving after the noise should still
                // settle the wait.
                await fetch(`${getRedirect()}?code=abc&state=${state}`)
            },
            timeoutMs: 5000,
        })
        expect(result.token).toBe('tok-1')
    })

    it('rejects an invalid preferredPort with AUTH_PORT_BIND_FAILED before opening the browser', async () => {
        const openBrowser = vi.fn(async () => undefined)
        const { provider } = instrument()
        const store = fakeStore()
        await expect(
            runOAuthFlow<Account>({
                provider,
                store,
                scopes: [],
                readOnly: false,
                flags: {},
                preferredPort: 70_000,
                renderSuccess,
                renderError,
                openBrowser,
                timeoutMs: 5000,
            }),
        ).rejects.toMatchObject({ code: 'AUTH_PORT_BIND_FAILED' })
        expect(openBrowser).not.toHaveBeenCalled()
    })

    it('halts via AbortSignal: aborting before the callback rejects with AUTH_OAUTH_FAILED and skips store.set', async () => {
        const controller = new AbortController()
        const { provider, getRedirect } = instrument()
        const store = fakeStore()
        const setSpy = vi.spyOn(store, 'set')

        await expect(
            runOAuthFlow<Account>({
                provider,
                store,
                scopes: [],
                readOnly: false,
                flags: {},
                preferredPort: 0,
                renderSuccess,
                renderError,
                openBrowser: async () => {
                    // Abort before the callback arrives — flow should reject
                    // with AUTH_OAUTH_FAILED rather than continue waiting.
                    controller.abort()
                    void getRedirect() // touch to silence unused-fn lint
                },
                onAuthorizeUrl: () => undefined,
                signal: controller.signal,
                timeoutMs: 5000,
            }),
        ).rejects.toMatchObject({ code: 'AUTH_OAUTH_FAILED' })
        expect(setSpy).not.toHaveBeenCalled()
    })

    it('falls back to onAuthorizeUrl when the openBrowser opener throws', async () => {
        const { provider, getRedirect } = instrument()
        const store = fakeStore()
        const onAuthorizeUrl = vi.fn(async (url: string) => {
            // Drive the callback off the URL we received via the fallback path.
            const state = new URL(url).searchParams.get('state') ?? ''
            await fetch(`${getRedirect()}?code=abc&state=${state}`)
        })
        const result = await runOAuthFlow<Account>({
            provider,
            store,
            scopes: [],
            readOnly: false,
            flags: {},
            preferredPort: 0,
            renderSuccess,
            renderError,
            openBrowser: async () => {
                throw new Error('opener boom')
            },
            onAuthorizeUrl,
            timeoutMs: 5000,
        })
        expect(onAuthorizeUrl).toHaveBeenCalledTimes(1)
        expect(onAuthorizeUrl.mock.calls[0][0]).toMatch(/^https:\/\/example\.com\/oauth\/authorize/)
        expect(result.token).toBe('tok-1')
    })

    it('wraps non-CliError store.set failures in AUTH_STORE_WRITE_FAILED', async () => {
        const { provider, getRedirect } = instrument()
        const store: TokenStore<Account> = {
            async active() {
                return null
            },
            async set() {
                throw new Error('disk full')
            },
            async clear() {},
        }
        await expect(
            runOAuthFlow<Account>({
                provider,
                store,
                scopes: [],
                readOnly: false,
                flags: {},
                preferredPort: 0,
                renderSuccess,
                renderError,
                openBrowser: async (url) => {
                    const state = new URL(url).searchParams.get('state') ?? ''
                    await fetch(`${getRedirect()}?code=abc&state=${state}`)
                },
                onAuthorizeUrl: () => undefined,
                timeoutMs: 5000,
            }),
        ).rejects.toMatchObject({ code: 'AUTH_STORE_WRITE_FAILED' })
    })
})
