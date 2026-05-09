import { describe, expect, it } from 'vitest'

import { createPkceProvider } from './pkce.js'

type Account = { id: string; label?: string; email: string }

const respond = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
    })

const validate = async () => ({ id: '1', email: 'a@b' }) as Account

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
