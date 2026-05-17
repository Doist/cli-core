import { describe, expect, it } from 'vitest'

import { buildPkceAuthorizeUrl, postTokenEndpoint, resolve, safeReadText } from './_oauth.js'

const TOKEN_URL = 'https://example.com/oauth/token'

describe('resolve', () => {
    it('returns literal strings unchanged', async () => {
        expect(await resolve('static', {}, {})).toBe('static')
    })

    it('passes handshake + flags to function resolvers', async () => {
        const got = await resolve(
            ({ handshake, flags }) => `${handshake.base as string}|${flags.clientId as string}`,
            { base: 'https://x' },
            { clientId: 'cid' },
        )
        expect(got).toBe('https://x|cid')
    })
})

describe('safeReadText', () => {
    it('returns trimmed body text', async () => {
        const res = new Response('  body text  ', { status: 400 })
        expect(await safeReadText(res)).toBe('body text')
    })

    it('returns undefined for empty bodies', async () => {
        const res = new Response('', { status: 400 })
        expect(await safeReadText(res)).toBeUndefined()
    })
})

describe('buildPkceAuthorizeUrl', () => {
    it('sets PKCE params and joins scopes with the supplied separator', () => {
        const url = new URL(
            buildPkceAuthorizeUrl({
                authorizeUrl: 'https://example.com/oauth/authorize',
                clientId: 'cid',
                redirectUri: 'http://localhost/cb',
                state: 'st',
                scopes: ['a', 'b'],
                scopeSeparator: ',',
                codeChallenge: 'challenge-1',
            }),
        )
        expect(url.searchParams.get('response_type')).toBe('code')
        expect(url.searchParams.get('client_id')).toBe('cid')
        expect(url.searchParams.get('redirect_uri')).toBe('http://localhost/cb')
        expect(url.searchParams.get('state')).toBe('st')
        expect(url.searchParams.get('code_challenge')).toBe('challenge-1')
        expect(url.searchParams.get('code_challenge_method')).toBe('S256')
        expect(url.searchParams.get('scope')).toBe('a,b')
    })

    it('omits scope when scopes is empty', () => {
        const url = new URL(
            buildPkceAuthorizeUrl({
                authorizeUrl: 'https://example.com/oauth/authorize',
                clientId: 'cid',
                redirectUri: 'http://localhost/cb',
                state: 'st',
                scopes: [],
                scopeSeparator: ' ',
                codeChallenge: 'c',
            }),
        )
        expect(url.searchParams.has('scope')).toBe(false)
    })
})

describe('postTokenEndpoint', () => {
    it('POSTs the form body, returns access_token + refresh_token + expiresAt', async () => {
        let captured: { url: string; init: RequestInit } | undefined
        const result = await postTokenEndpoint({
            url: TOKEN_URL,
            body: new URLSearchParams({ grant_type: 'authorization_code', code: 'c' }),
            fetchImpl: ((url, init = {}) => {
                captured = { url: String(url), init }
                return Promise.resolve(
                    new Response(
                        JSON.stringify({
                            access_token: 'tok',
                            refresh_token: 'rtok',
                            expires_in: 60,
                        }),
                        { status: 200, headers: { 'Content-Type': 'application/json' } },
                    ),
                )
            }) as typeof fetch,
        })
        expect(result.accessToken).toBe('tok')
        expect(result.refreshToken).toBe('rtok')
        expect(result.expiresAt).toBeGreaterThan(Date.now())
        expect(captured?.url).toBe(TOKEN_URL)
        expect(captured?.init.method).toBe('POST')
        const headers = captured?.init.headers as Record<string, string>
        expect(headers['Content-Type']).toBe('application/x-www-form-urlencoded')
        expect(headers.Authorization).toBeUndefined()
    })

    it('adds Authorization: Basic when basicAuth is supplied', async () => {
        let headers: Record<string, string> | undefined
        await postTokenEndpoint({
            url: TOKEN_URL,
            body: new URLSearchParams({ grant_type: 'authorization_code' }),
            basicAuth: { clientId: 'cid', clientSecret: 'sec' },
            fetchImpl: ((_url, init = {}) => {
                headers = init.headers as Record<string, string>
                return Promise.resolve(
                    new Response(JSON.stringify({ access_token: 'x' }), { status: 200 }),
                )
            }) as typeof fetch,
        })
        expect(headers?.Authorization).toBe(
            `Basic ${Buffer.from('cid:sec', 'utf8').toString('base64')}`,
        )
    })

    it('refresh_token grants reuse the same helper', async () => {
        let body: string | undefined
        const result = await postTokenEndpoint({
            url: TOKEN_URL,
            body: new URLSearchParams({
                grant_type: 'refresh_token',
                refresh_token: 'old-rtok',
                client_id: 'cid',
            }),
            fetchImpl: ((_url, init = {}) => {
                body = init.body as string
                return Promise.resolve(
                    new Response(
                        JSON.stringify({ access_token: 'new', refresh_token: 'new-rtok' }),
                        { status: 200 },
                    ),
                )
            }) as typeof fetch,
        })
        expect(result.accessToken).toBe('new')
        expect(result.refreshToken).toBe('new-rtok')
        expect(new URLSearchParams(body).get('grant_type')).toBe('refresh_token')
    })

    it('network errors throw AUTH_TOKEN_EXCHANGE_FAILED', async () => {
        await expect(
            postTokenEndpoint({
                url: TOKEN_URL,
                body: new URLSearchParams(),
                fetchImpl: (() => Promise.reject(new Error('econnrefused'))) as typeof fetch,
            }),
        ).rejects.toMatchObject({ code: 'AUTH_TOKEN_EXCHANGE_FAILED' })
    })

    it('non-2xx surfaces user errorHints first, then the body as a hint', async () => {
        await expect(
            postTokenEndpoint({
                url: TOKEN_URL,
                body: new URLSearchParams(),
                errorHints: ['Re-run login'],
                fetchImpl: (() =>
                    Promise.resolve(
                        new Response('invalid_grant', { status: 400 }),
                    )) as typeof fetch,
            }),
        ).rejects.toMatchObject({
            code: 'AUTH_TOKEN_EXCHANGE_FAILED',
            hints: ['Re-run login', 'invalid_grant'],
        })
    })

    it('2xx HTML / non-JSON body throws AUTH_TOKEN_EXCHANGE_FAILED', async () => {
        await expect(
            postTokenEndpoint({
                url: TOKEN_URL,
                body: new URLSearchParams(),
                fetchImpl: (() =>
                    Promise.resolve(
                        new Response('<html>oops</html>', {
                            status: 200,
                            headers: { 'Content-Type': 'text/html' },
                        }),
                    )) as typeof fetch,
            }),
        ).rejects.toMatchObject({ code: 'AUTH_TOKEN_EXCHANGE_FAILED' })
    })

    it('errorHints are prepended to every CliError, with body text appended after on non-2xx', async () => {
        // Non-2xx: both user hints AND body detail.
        await expect(
            postTokenEndpoint({
                url: TOKEN_URL,
                body: new URLSearchParams(),
                errorHints: ['Re-run login', 'Set TWIST_API_TOKEN'],
                fetchImpl: (() =>
                    Promise.resolve(
                        new Response('invalid_grant', { status: 400 }),
                    )) as typeof fetch,
            }),
        ).rejects.toMatchObject({
            code: 'AUTH_TOKEN_EXCHANGE_FAILED',
            hints: ['Re-run login', 'Set TWIST_API_TOKEN', 'invalid_grant'],
        })

        // Network failure: user hints only (no server detail to append).
        await expect(
            postTokenEndpoint({
                url: TOKEN_URL,
                body: new URLSearchParams(),
                errorHints: ['Re-run login'],
                fetchImpl: (() => Promise.reject(new Error('econnrefused'))) as typeof fetch,
            }),
        ).rejects.toMatchObject({
            code: 'AUTH_TOKEN_EXCHANGE_FAILED',
            hints: ['Re-run login'],
        })
    })

    it('missing access_token throws AUTH_TOKEN_EXCHANGE_FAILED', async () => {
        await expect(
            postTokenEndpoint({
                url: TOKEN_URL,
                body: new URLSearchParams(),
                fetchImpl: (() =>
                    Promise.resolve(
                        new Response(JSON.stringify({ refresh_token: 'r' }), { status: 200 }),
                    )) as typeof fetch,
            }),
        ).rejects.toMatchObject({ code: 'AUTH_TOKEN_EXCHANGE_FAILED' })
    })
})
