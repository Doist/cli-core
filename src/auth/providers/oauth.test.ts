import { describe, expect, it } from 'vitest'

import { postTokenEndpoint } from './oauth.js'

const TOKEN_URL = 'https://example.com/oauth/token'

describe('postTokenEndpoint', () => {
    it('POSTs the form body, returns access_token + refresh_token + expiresAt, sets no Authorization header', async () => {
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
                        { status: 200 },
                    ),
                )
            }) as typeof fetch,
        })
        expect(result).toMatchObject({ accessToken: 'tok', refreshToken: 'rtok' })
        expect(result.expiresAt).toBeGreaterThan(Date.now())
        expect(captured?.url).toBe(TOKEN_URL)
        const headers = captured?.init.headers as Record<string, string>
        expect(headers['Content-Type']).toBe('application/x-www-form-urlencoded')
        expect(headers.Authorization).toBeUndefined()
    })

    it('non-2xx wraps as AUTH_TOKEN_EXCHANGE_FAILED with user errorHints first and body text second', async () => {
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

    it('network errors, non-JSON bodies, and responses missing access_token all become AUTH_TOKEN_EXCHANGE_FAILED', async () => {
        const cases: Array<() => Promise<Response>> = [
            () => Promise.reject(new Error('econnrefused')),
            () =>
                Promise.resolve(
                    new Response('<html>oops</html>', {
                        status: 200,
                        headers: { 'Content-Type': 'text/html' },
                    }),
                ),
            () =>
                Promise.resolve(
                    new Response(JSON.stringify({ refresh_token: 'r' }), { status: 200 }),
                ),
        ]
        for (const fetchImpl of cases) {
            await expect(
                postTokenEndpoint({
                    url: TOKEN_URL,
                    body: new URLSearchParams(),
                    fetchImpl: fetchImpl as typeof fetch,
                }),
            ).rejects.toMatchObject({ code: 'AUTH_TOKEN_EXCHANGE_FAILED' })
        }
    })
})
