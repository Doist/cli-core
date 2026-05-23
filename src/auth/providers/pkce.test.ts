import { afterEach, describe, expect, it, vi } from 'vitest'

import { type TestAccount as Account, alanGrant } from '../../test-support/accounts.js'
import { createPkceProvider } from './pkce.js'

const respond = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
    })

const validate = async (): Promise<Account> => alanGrant

describe('createPkceProvider', () => {
    it('builds an authorize URL with response_type / client_id / redirect_uri / state / S256 code_challenge / scope', async () => {
        const provider = createPkceProvider<Account>({
            authorizeUrl: 'https://example.com/oauth/authorize',
            tokenUrl: 'https://example.com/oauth/token',
            clientId: 'client-xyz',
            validate,
        })

        const result = await provider.authorize({
            redirectUri: 'http://localhost:8765/callback',
            state: 'state-123',
            scopes: ['read', 'write'],
            readOnly: false,
            flags: {},
            handshake: {},
        })

        const url = new URL(result.authorizeUrl)
        expect(url.searchParams.get('client_id')).toBe('client-xyz')
        expect(url.searchParams.get('redirect_uri')).toBe('http://localhost:8765/callback')
        expect(url.searchParams.get('state')).toBe('state-123')
        expect(url.searchParams.get('code_challenge_method')).toBe('S256')
        expect(url.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]+$/)
        expect(url.searchParams.get('scope')).toBe('read write')
        expect(typeof result.handshake.codeVerifier).toBe('string')
    })

    it('honours scopeSeparator and the lazy-string resolvers (Todoist + Outline-style)', async () => {
        const provider = createPkceProvider<Account>({
            authorizeUrl: ({ handshake }) => `${handshake.baseUrl as string}/oauth/authorize`,
            tokenUrl: 'unused',
            clientId: ({ flags }) => flags.clientId as string,
            scopeSeparator: ',',
            validate,
        })
        const result = await provider.authorize({
            redirectUri: 'http://localhost/callback',
            state: 's',
            scopes: ['data:read_write', 'data:delete'],
            readOnly: false,
            flags: { clientId: 'flag-id' },
            handshake: { baseUrl: 'https://outline.example' },
        })
        const url = new URL(result.authorizeUrl)
        expect(url.origin).toBe('https://outline.example')
        expect(url.searchParams.get('client_id')).toBe('flag-id')
        expect(url.searchParams.get('scope')).toBe('data:read_write,data:delete')
    })

    it('supports async resolvers (consumer resolves base URL / client id asynchronously)', async () => {
        const provider = createPkceProvider<Account>({
            authorizeUrl: async ({ handshake }) => `${handshake.baseUrl as string}/oauth/authorize`,
            tokenUrl: 'unused',
            clientId: async () => 'async-client',
            validate,
        })
        const result = await provider.authorize({
            redirectUri: 'http://localhost/callback',
            state: 's',
            scopes: [],
            readOnly: false,
            flags: {},
            handshake: { baseUrl: 'https://async.example' },
        })
        const url = new URL(result.authorizeUrl)
        expect(url.origin).toBe('https://async.example')
        expect(url.searchParams.get('client_id')).toBe('async-client')
    })

    it('exchangeCode POSTs without client_secret and surfaces token endpoint failures as AUTH_TOKEN_EXCHANGE_FAILED', async () => {
        const ok = createPkceProvider<Account>({
            authorizeUrl: 'unused',
            tokenUrl: 'https://example.com/oauth/token',
            clientId: 'client-xyz',
            validate,
            fetchImpl: ((_url: RequestInfo | URL, init: RequestInit = {}) => {
                const body = new URLSearchParams(init.body as string)
                expect(body.get('grant_type')).toBe('authorization_code')
                expect(body.get('client_id')).toBe('client-xyz')
                expect(body.get('code_verifier')).toBe('the-verifier')
                expect(body.has('client_secret')).toBe(false)
                return Promise.resolve(respond({ access_token: 'tok-1', expires_in: 3600 }))
            }) as typeof fetch,
        })
        const result = await ok.exchangeCode({
            code: 'the-code',
            state: 's',
            redirectUri: 'http://localhost/callback',
            handshake: { codeVerifier: 'the-verifier', clientId: 'client-xyz' },
        })
        expect(result.accessToken).toBe('tok-1')
        expect(result.expiresAt).toBeGreaterThan(Date.now())

        const failing = createPkceProvider<Account>({
            authorizeUrl: 'unused',
            tokenUrl: 'https://example.com/oauth/token',
            clientId: 'cid',
            validate,
            fetchImpl: (() =>
                Promise.resolve(new Response('nope', { status: 400 }))) as typeof fetch,
        })
        await expect(
            failing.exchangeCode({
                code: 'c',
                state: 's',
                redirectUri: 'http://localhost/callback',
                handshake: { codeVerifier: 'v', clientId: 'cid' },
            }),
        ).rejects.toMatchObject({ code: 'AUTH_TOKEN_EXCHANGE_FAILED' })
    })

    it('throws AUTH_TOKEN_EXCHANGE_FAILED when a 2xx response is not valid JSON (e.g. proxy HTML)', async () => {
        const provider = createPkceProvider<Account>({
            authorizeUrl: 'unused',
            tokenUrl: 'https://example.com/oauth/token',
            clientId: 'cid',
            validate,
            fetchImpl: (() =>
                Promise.resolve(
                    new Response('<html>oops</html>', {
                        status: 200,
                        headers: { 'Content-Type': 'text/html' },
                    }),
                )) as typeof fetch,
        })
        await expect(
            provider.exchangeCode({
                code: 'c',
                state: 's',
                redirectUri: 'http://localhost/callback',
                handshake: { codeVerifier: 'v', clientId: 'cid' },
            }),
        ).rejects.toMatchObject({ code: 'AUTH_TOKEN_EXCHANGE_FAILED' })
    })

    it('forwards errorHints onto both the token-endpoint failure and the handshake-lost guard', async () => {
        const provider = createPkceProvider<Account>({
            authorizeUrl: 'unused',
            tokenUrl: 'https://example.com/oauth/token',
            clientId: 'cid',
            validate,
            errorHints: ['Re-run login'],
            fetchImpl: (() =>
                Promise.resolve(new Response('invalid_grant', { status: 400 }))) as typeof fetch,
        })
        await expect(
            provider.exchangeCode({
                code: 'c',
                state: 's',
                redirectUri: 'http://localhost/callback',
                handshake: { codeVerifier: 'v', clientId: 'cid' },
            }),
        ).rejects.toMatchObject({
            code: 'AUTH_TOKEN_EXCHANGE_FAILED',
            hints: ['Re-run login', 'invalid_grant'],
        })
        // Same hints flow through the internal handshake-lost guard.
        await expect(
            provider.exchangeCode({
                code: 'c',
                state: 's',
                redirectUri: 'http://localhost/callback',
                handshake: {},
            }),
        ).rejects.toMatchObject({
            code: 'AUTH_TOKEN_EXCHANGE_FAILED',
            hints: ['Re-run login'],
        })
    })

    it('throws AUTH_TOKEN_EXCHANGE_FAILED when the handshake state was lost between authorize and exchange', async () => {
        const provider = createPkceProvider<Account>({
            authorizeUrl: 'unused',
            tokenUrl: 'unused',
            clientId: 'cid',
            validate,
        })
        await expect(
            provider.exchangeCode({
                code: 'c',
                state: 's',
                redirectUri: 'http://localhost/callback',
                handshake: {},
            }),
        ).rejects.toMatchObject({ code: 'AUTH_TOKEN_EXCHANGE_FAILED' })
    })
})

describe('createPkceProvider.refreshToken', () => {
    function refreshProvider() {
        return createPkceProvider<Account>({
            authorizeUrl: 'https://example.com/oauth/authorize',
            tokenUrl: 'https://example.com/oauth/token',
            clientId: 'client-xyz',
            validate,
        })
    }

    function stubFetch(impl: typeof fetch): void {
        vi.spyOn(globalThis, 'fetch').mockImplementation(impl)
    }

    afterEach(() => {
        vi.restoreAllMocks()
    })

    it('POSTs the refresh grant and returns the rotated bundle', async () => {
        stubFetch(
            (async () =>
                new Response(
                    JSON.stringify({
                        access_token: 'tok-new',
                        refresh_token: 'r-new',
                        expires_in: 3600,
                        token_type: 'bearer',
                    }),
                    { status: 200, headers: { 'Content-Type': 'application/json' } },
                )) as typeof fetch,
        )

        const result = await refreshProvider().refreshToken!({
            refreshToken: 'r-old',
            handshake: {},
        })

        expect(result).toMatchObject({ accessToken: 'tok-new', refreshToken: 'r-new' })
        expect(result.expiresAt).toBeGreaterThan(Date.now())
    })

    it('routes the refresh grant through an injected fetchImpl, never the global fetch', async () => {
        // Custom-transport consumers (proxy dispatcher) inject `fetchImpl`;
        // it must reach oauth4webapi's customFetch. Global fetch is rigged to
        // throw so any leak to it fails loudly.
        let capturedUrl: string | undefined
        const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
            capturedUrl = String(input)
            return new Response(JSON.stringify({ access_token: 'tok-new', token_type: 'bearer' }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            })
        }) as unknown as typeof fetch
        const globalSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((() => {
            throw new Error('global fetch must not be used when fetchImpl is injected')
        }) as typeof fetch)

        const provider = createPkceProvider<Account>({
            authorizeUrl: 'https://example.com/oauth/authorize',
            tokenUrl: 'https://example.com/oauth/token',
            clientId: 'client-xyz',
            validate,
            fetchImpl,
        })

        const result = await provider.refreshToken!({ refreshToken: 'r-old', handshake: {} })

        expect(result.accessToken).toBe('tok-new')
        expect(capturedUrl).toBe('https://example.com/oauth/token')
        expect(globalSpy).not.toHaveBeenCalled()
    })

    it('resolves async tokenUrl / clientId from the handshake on the refresh path', async () => {
        let capturedUrl: string | undefined
        let capturedClientId: string | undefined
        const fetchImpl = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
            capturedUrl = String(input)
            capturedClientId =
                new URLSearchParams(init.body as string).get('client_id') ?? undefined
            return new Response(JSON.stringify({ access_token: 'tok-new', token_type: 'bearer' }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            })
        }) as unknown as typeof fetch

        const provider = createPkceProvider<Account>({
            authorizeUrl: 'unused',
            tokenUrl: async ({ handshake }) => `${handshake.baseUrl as string}/oauth/token`,
            clientId: async () => 'async-client',
            validate,
            fetchImpl,
        })

        const result = await provider.refreshToken!({
            refreshToken: 'r-old',
            handshake: { baseUrl: 'https://wiki.example.com' },
        })

        expect(result.accessToken).toBe('tok-new')
        expect(capturedUrl).toBe('https://wiki.example.com/oauth/token')
        expect(capturedClientId).toBe('async-client')
    })

    it('maps invalid_grant to AUTH_REFRESH_EXPIRED (any HTTP status — proxies remap 400/401)', async () => {
        stubFetch(
            (async () =>
                new Response(JSON.stringify({ error: 'invalid_grant' }), {
                    status: 401,
                    headers: { 'Content-Type': 'application/json' },
                })) as typeof fetch,
        )

        await expect(
            refreshProvider().refreshToken!({ refreshToken: 'r-old', handshake: {} }),
        ).rejects.toMatchObject({ code: 'AUTH_REFRESH_EXPIRED' })
    })

    it('maps everything else (network, 5xx, non-JSON, other OAuth errors) to AUTH_REFRESH_TRANSIENT', async () => {
        stubFetch((async () => {
            throw new Error('connection reset')
        }) as typeof fetch)

        await expect(
            refreshProvider().refreshToken!({ refreshToken: 'r-old', handshake: {} }),
        ).rejects.toMatchObject({ code: 'AUTH_REFRESH_TRANSIENT' })
    })

    it('surfaces the server OAuth error code + description (not oauth4webapi’s generic message)', async () => {
        stubFetch(
            (async () =>
                new Response(
                    JSON.stringify({
                        error: 'invalid_request',
                        error_description: 'Missing client_secret for confidential client',
                    }),
                    { status: 400, headers: { 'Content-Type': 'application/json' } },
                )) as typeof fetch,
        )

        await expect(
            refreshProvider().refreshToken!({ refreshToken: 'r-old', handshake: {} }),
        ).rejects.toMatchObject({
            code: 'AUTH_REFRESH_TRANSIENT',
            message:
                'Refresh request failed: invalid_request (Missing client_secret for confidential client)',
        })
    })

    it('maps a missing oauth4webapi peer dep to AUTH_REFRESH_UNAVAILABLE', async () => {
        // The optional peer dep isn't installed → the lazy import fails. Force
        // that by mocking the module to throw, then re-importing the provider
        // so its lazy `import('oauth4webapi')` resolves to the throwing mock.
        vi.resetModules()
        vi.doMock('oauth4webapi', () => {
            throw new Error("Cannot find package 'oauth4webapi'")
        })
        try {
            const { createPkceProvider: freshCreate } = await import('./pkce.js')
            const provider = freshCreate<Account>({
                authorizeUrl: 'https://example.com/oauth/authorize',
                tokenUrl: 'https://example.com/oauth/token',
                clientId: 'client-xyz',
                validate,
            })
            await expect(
                provider.refreshToken!({ refreshToken: 'r-old', handshake: {} }),
            ).rejects.toMatchObject({ code: 'AUTH_REFRESH_UNAVAILABLE' })
        } finally {
            vi.doUnmock('oauth4webapi')
            vi.resetModules()
        }
    })
})
