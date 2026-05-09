import { describe, expect, it, vi } from 'vitest'

import { createDcrProvider } from './dcr.js'

type Account = { id: string; label?: string; email: string }

function makeFetch(
    handler: (url: string, init: RequestInit) => Response | Promise<Response>,
): typeof fetch {
    return ((input: RequestInfo | URL, init: RequestInit = {}) =>
        Promise.resolve(handler(String(input), init))) as typeof fetch
}

describe('createDcrProvider — prepare', () => {
    it('POSTs registration body and returns client_id/client_secret in handshake', async () => {
        const fetchImpl = vi.fn(
            makeFetch((url, init) => {
                expect(url).toBe('https://twist.com/oauth/register')
                expect(init.method).toBe('POST')
                const body = JSON.parse(init.body as string)
                expect(body.client_name).toBe('Twist CLI')
                expect(body.redirect_uris).toEqual(['http://localhost:8766/callback'])
                expect(body.grant_types).toEqual(['authorization_code'])
                expect(body.response_types).toEqual(['code'])
                expect(body.token_endpoint_auth_method).toBe('client_secret_basic')
                expect(body.application_type).toBe('native')
                expect(body.client_uri).toBe('https://github.com/Doist/twist-cli')
                expect(body.logo_uri).toBe('https://example.com/logo.png')
                return new Response(
                    JSON.stringify({ client_id: 'cid-1', client_secret: 'csec-1' }),
                    { status: 200, headers: { 'Content-Type': 'application/json' } },
                )
            }),
        )

        const provider = createDcrProvider<Account>({
            registerUrl: 'https://twist.com/oauth/register',
            authorizeUrl: 'https://twist.com/oauth/authorize',
            tokenUrl: 'https://twist.com/oauth/token',
            clientName: 'Twist CLI',
            clientUri: 'https://github.com/Doist/twist-cli',
            registrationMetadata: { logo_uri: 'https://example.com/logo.png' },
            scopes: ['user:read'],
            validate: async () => ({ id: '1', email: 'a@b' }),
            fetchImpl,
        })

        const result = await provider.prepare?.({
            redirectUri: 'http://localhost:8766/callback',
            flags: {},
        })
        expect(result?.handshake).toEqual({ clientId: 'cid-1', clientSecret: 'csec-1' })
    })

    it('throws AUTH_DCR_FAILED on non-2xx', async () => {
        const provider = createDcrProvider<Account>({
            registerUrl: 'https://twist.com/oauth/register',
            authorizeUrl: 'unused',
            tokenUrl: 'unused',
            clientName: 'Twist CLI',
            scopes: [],
            validate: async () => ({ id: '1', email: 'a@b' }),
            fetchImpl: makeFetch(() => new Response('nope', { status: 400 })),
        })
        await expect(
            provider.prepare?.({ redirectUri: 'http://localhost/callback', flags: {} }),
        ).rejects.toMatchObject({ code: 'AUTH_DCR_FAILED' })
    })

    it('throws AUTH_DCR_FAILED when response is missing client_id or client_secret', async () => {
        const provider = createDcrProvider<Account>({
            registerUrl: 'https://twist.com/oauth/register',
            authorizeUrl: 'unused',
            tokenUrl: 'unused',
            clientName: 'Twist CLI',
            scopes: [],
            validate: async () => ({ id: '1', email: 'a@b' }),
            fetchImpl: makeFetch(
                () =>
                    new Response(JSON.stringify({ client_id: 'only-id' }), {
                        status: 200,
                        headers: { 'Content-Type': 'application/json' },
                    }),
            ),
        })
        await expect(
            provider.prepare?.({ redirectUri: 'http://localhost/callback', flags: {} }),
        ).rejects.toMatchObject({ code: 'AUTH_DCR_FAILED' })
    })
})

describe('createDcrProvider — exchangeCode', () => {
    it('sends Authorization: Basic base64(client_id:client_secret) and code_verifier', async () => {
        const fetchImpl = vi.fn(
            makeFetch((url, init) => {
                expect(url).toBe('https://twist.com/oauth/token')
                expect(init.method).toBe('POST')
                const headers = init.headers as Record<string, string>
                const expected = Buffer.from('cid-1:csec-1').toString('base64')
                expect(headers.Authorization).toBe(`Basic ${expected}`)
                expect(headers['Content-Type']).toBe('application/x-www-form-urlencoded')
                const body = new URLSearchParams(init.body as string)
                expect(body.get('grant_type')).toBe('authorization_code')
                expect(body.get('code')).toBe('the-code')
                expect(body.get('code_verifier')).toBe('the-verifier')
                expect(body.has('client_id')).toBe(false)
                expect(body.has('client_secret')).toBe(false)
                return new Response(JSON.stringify({ access_token: 'tok-1' }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                })
            }),
        )

        const provider = createDcrProvider<Account>({
            registerUrl: 'https://twist.com/oauth/register',
            authorizeUrl: 'https://twist.com/oauth/authorize',
            tokenUrl: 'https://twist.com/oauth/token',
            clientName: 'Twist CLI',
            scopes: [],
            validate: async () => ({ id: '1', email: 'a@b' }),
            fetchImpl,
        })

        const result = await provider.exchangeCode({
            code: 'the-code',
            state: 's',
            redirectUri: 'http://localhost:8766/callback',
            handshake: {
                clientId: 'cid-1',
                clientSecret: 'csec-1',
                codeVerifier: 'the-verifier',
            },
        })
        expect(result.accessToken).toBe('tok-1')
    })
})
