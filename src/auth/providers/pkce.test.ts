import { describe, expect, it, vi } from 'vitest'

import { createPkceProvider } from './pkce.js'

type Account = { id: string; label?: string; email: string }

function makeFetch(
    handler: (url: string, init: RequestInit) => Response | Promise<Response>,
): typeof fetch {
    return ((input: RequestInfo | URL, init: RequestInit = {}) =>
        Promise.resolve(handler(String(input), init))) as typeof fetch
}

describe('createPkceProvider — authorize', () => {
    it('builds a URL with response_type, client_id, redirect_uri, state, code_challenge_method=S256, scope', async () => {
        const provider = createPkceProvider<Account>({
            authorizeUrl: 'https://example.com/oauth/authorize',
            tokenUrl: 'https://example.com/oauth/token',
            clientId: 'client-xyz',
            scopes: ['read', 'write'],
            validate: async () => ({ id: '1', email: 'a@b' }),
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
        expect(url.origin + url.pathname).toBe('https://example.com/oauth/authorize')
        expect(url.searchParams.get('response_type')).toBe('code')
        expect(url.searchParams.get('client_id')).toBe('client-xyz')
        expect(url.searchParams.get('redirect_uri')).toBe('http://localhost:8765/callback')
        expect(url.searchParams.get('state')).toBe('state-123')
        expect(url.searchParams.get('code_challenge_method')).toBe('S256')
        expect(url.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]+$/)
        expect(url.searchParams.get('scope')).toBe('read write')
        expect(typeof result.handshake.codeVerifier).toBe('string')
    })

    it('honours scopeSeparator for comma-separated providers (Todoist)', async () => {
        const provider = createPkceProvider<Account>({
            authorizeUrl: 'https://todoist.com/oauth/authorize',
            tokenUrl: 'https://todoist.com/oauth/access_token',
            clientId: 'todoist-id',
            scopes: ['data:read_write', 'data:delete'],
            scopeSeparator: ',',
            validate: async () => ({ id: '1', email: 'a@b' }),
        })

        const result = await provider.authorize({
            redirectUri: 'http://localhost:8765/callback',
            state: 's',
            scopes: ['data:read_write', 'data:delete'],
            readOnly: false,
            flags: {},
            handshake: {},
        })
        expect(new URL(result.authorizeUrl).searchParams.get('scope')).toBe(
            'data:read_write,data:delete',
        )
    })

    it('resolves authorizeUrl from a function (self-hosted Outline)', async () => {
        const provider = createPkceProvider<Account>({
            authorizeUrl: ({ handshake }) => `${handshake.baseUrl as string}/oauth/authorize`,
            tokenUrl: 'unused',
            clientId: 'cid',
            scopes: ['read'],
            validate: async () => ({ id: '1', email: 'a@b' }),
        })
        const result = await provider.authorize({
            redirectUri: 'http://localhost:8765/callback',
            state: 's',
            scopes: ['read'],
            readOnly: false,
            flags: {},
            handshake: { baseUrl: 'https://my.outline.example' },
        })
        expect(new URL(result.authorizeUrl).origin).toBe('https://my.outline.example')
    })
})

describe('createPkceProvider — exchangeCode', () => {
    it('POSTs form-encoded body without client_secret, returns access_token', async () => {
        const fetchImpl = vi.fn(
            makeFetch((url, init) => {
                expect(url).toBe('https://example.com/oauth/token')
                expect(init.method).toBe('POST')
                const headers = init.headers as Record<string, string>
                expect(headers['Content-Type']).toBe('application/x-www-form-urlencoded')
                const body = new URLSearchParams(init.body as string)
                expect(body.get('grant_type')).toBe('authorization_code')
                expect(body.get('code')).toBe('the-code')
                expect(body.get('redirect_uri')).toBe('http://localhost:8765/callback')
                expect(body.get('client_id')).toBe('client-xyz')
                expect(body.get('code_verifier')).toBe('the-verifier')
                expect(body.has('client_secret')).toBe(false)
                return new Response(JSON.stringify({ access_token: 'tok-1', expires_in: 3600 }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                })
            }),
        )

        const provider = createPkceProvider<Account>({
            authorizeUrl: 'https://example.com/oauth/authorize',
            tokenUrl: 'https://example.com/oauth/token',
            clientId: 'client-xyz',
            scopes: ['read'],
            validate: async () => ({ id: '1', email: 'a@b' }),
            fetchImpl,
        })

        const result = await provider.exchangeCode({
            code: 'the-code',
            state: 's',
            redirectUri: 'http://localhost:8765/callback',
            handshake: { codeVerifier: 'the-verifier', clientId: 'client-xyz' },
        })
        expect(result.accessToken).toBe('tok-1')
        expect(result.expiresAt).toBeGreaterThan(Date.now())
    })

    it('throws AUTH_TOKEN_EXCHANGE_FAILED on non-2xx', async () => {
        const provider = createPkceProvider<Account>({
            authorizeUrl: 'https://example.com/oauth/authorize',
            tokenUrl: 'https://example.com/oauth/token',
            clientId: 'cid',
            scopes: ['read'],
            validate: async () => ({ id: '1', email: 'a@b' }),
            fetchImpl: makeFetch(() => new Response('nope', { status: 400 })),
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

    it('throws when handshake state is missing', async () => {
        const provider = createPkceProvider<Account>({
            authorizeUrl: 'unused',
            tokenUrl: 'unused',
            clientId: 'cid',
            scopes: ['read'],
            validate: async () => ({ id: '1', email: 'a@b' }),
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
