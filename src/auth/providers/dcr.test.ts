import { describe, expect, it, vi } from 'vitest'

import { createDcrProvider } from './dcr.js'
import type { DcrRegisteredClient } from './dcr.js'

type Account = { id: string; label?: string }

const respond = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
    })

/** RFC 7591 success: 201 Created. `client_secret_expires_at` is required when a secret is issued. */
const registration = (body: Record<string, unknown>): Response =>
    respond('client_secret' in body ? { client_secret_expires_at: 0, ...body } : body, 201)

/** oauth4webapi requires `token_type` on a token response. */
const token = (body: Record<string, unknown>): Response =>
    respond({ token_type: 'bearer', ...body })

const validate = async () => ({ id: '1' }) as Account

const REGISTRATION_URL = 'https://example.com/oauth/register'
const AUTHORIZE_URL = 'https://example.com/oauth/authorize'
const TOKEN_URL = 'https://example.com/oauth/token'
const REDIRECT_URI = 'http://localhost:8765/callback'

type FetchCall = { url: string; init: RequestInit }

function makeFetchRecorder(handler: (url: string) => Response): {
    calls: FetchCall[]
    fetchImpl: typeof fetch
} {
    const calls: FetchCall[] = []
    const fetchImpl = ((url: RequestInfo | URL, init: RequestInit = {}) => {
        const u = String(url)
        calls.push({ url: u, init })
        return Promise.resolve(handler(u))
    }) as typeof fetch
    return { calls, fetchImpl }
}

const headersOf = (call: FetchCall): Headers => new Headers(call.init.headers as HeadersInit)
const bodyOf = (call: FetchCall): URLSearchParams => new URLSearchParams(call.init.body as string)

describe('createDcrProvider', () => {
    it('prepare POSTs RFC 7591 metadata, authorize uses the issued client_id, exchangeCode sends Basic auth', async () => {
        const { calls, fetchImpl } = makeFetchRecorder((u) =>
            u === REGISTRATION_URL
                ? registration({ client_id: 'twd_id', client_secret: 'se+cr/et' })
                : token({ access_token: 'tok-1', expires_in: 3600 }),
        )
        const provider = createDcrProvider<Account>({
            registrationUrl: REGISTRATION_URL,
            authorizeUrl: AUTHORIZE_URL,
            tokenUrl: TOKEN_URL,
            clientMetadata: {
                clientName: 'Twist CLI',
                clientUri: 'https://github.com/doist/twist-cli',
                logoUri: 'https://example.com/logo.png',
                applicationType: 'native',
            },
            validate,
            fetchImpl,
        })

        const prepared = await provider.prepare!({ redirectUri: REDIRECT_URI, flags: {} })
        expect(prepared.handshake).toEqual({ clientId: 'twd_id', clientSecret: 'se+cr/et' })

        const regBody = JSON.parse(calls[0].init.body as string) as Record<string, unknown>
        expect(regBody).toMatchObject({
            client_name: 'Twist CLI',
            client_uri: 'https://github.com/doist/twist-cli',
            logo_uri: 'https://example.com/logo.png',
            application_type: 'native',
            redirect_uris: [REDIRECT_URI],
            grant_types: ['authorization_code'],
            response_types: ['code'],
            token_endpoint_auth_method: 'client_secret_basic',
        })

        const authorize = await provider.authorize({
            redirectUri: REDIRECT_URI,
            state: 'state-123',
            scopes: ['user:read', 'threads:read'],
            readOnly: false,
            flags: {},
            handshake: prepared.handshake,
        })
        const url = new URL(authorize.authorizeUrl)
        expect(url.searchParams.get('client_id')).toBe('twd_id')
        expect(url.searchParams.get('redirect_uri')).toBe(REDIRECT_URI)
        expect(url.searchParams.get('state')).toBe('state-123')
        expect(url.searchParams.get('code_challenge_method')).toBe('S256')
        expect(url.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]+$/)
        expect(url.searchParams.get('scope')).toBe('user:read threads:read')
        expect(typeof authorize.handshake.codeVerifier).toBe('string')
        expect(authorize.handshake.clientSecret).toBe('se+cr/et')

        const result = await provider.exchangeCode({
            code: 'auth-code',
            state: 'state-123',
            redirectUri: REDIRECT_URI,
            handshake: authorize.handshake,
        })
        expect(result.accessToken).toBe('tok-1')
        expect(result.expiresAt).toBeGreaterThan(Date.now())

        const tokenCall = calls.find((c) => c.url === TOKEN_URL)!
        // RFC 3986 per-component encoding: the unreserved `_` is preserved (so
        // servers that don't url-decode the Basic credential still match — the
        // bug oauth4webapi's §2.3.1 `%5F` escaping caused), while reserved chars
        // (`+` → `%2B`, `/` → `%2F`) are escaped so a conformant server
        // reconstructs them.
        expect(headersOf(tokenCall).get('authorization')).toBe(
            `Basic ${Buffer.from('twd_id:se%2Bcr%2Fet', 'utf8').toString('base64')}`,
        )
        const tokenBody = bodyOf(tokenCall)
        expect(tokenBody.get('grant_type')).toBe('authorization_code')
        expect(tokenBody.get('code')).toBe('auth-code')
        expect(tokenBody.get('redirect_uri')).toBe(REDIRECT_URI)
        expect(tokenBody.get('code_verifier')).toBe(authorize.handshake.codeVerifier as string)
        expect(tokenBody.has('client_id')).toBe(false)
        expect(tokenBody.has('client_secret')).toBe(false)
    })

    it('client_secret_post puts the secret in the body, omits the Authorization header, and forwards the auth method in the registration POST', async () => {
        const { calls, fetchImpl } = makeFetchRecorder((u) =>
            u === REGISTRATION_URL
                ? registration({ client_id: 'cid', client_secret: 'sec' })
                : token({ access_token: 'tok-2' }),
        )
        const provider = createDcrProvider<Account>({
            registrationUrl: REGISTRATION_URL,
            authorizeUrl: AUTHORIZE_URL,
            tokenUrl: TOKEN_URL,
            clientMetadata: { clientName: 'CLI', tokenEndpointAuthMethod: 'client_secret_post' },
            validate,
            fetchImpl,
        })

        const prepared = await provider.prepare!({ redirectUri: REDIRECT_URI, flags: {} })
        const regBody = JSON.parse(calls[0].init.body as string) as Record<string, unknown>
        expect(regBody.token_endpoint_auth_method).toBe('client_secret_post')

        await provider.exchangeCode({
            code: 'c',
            state: 's',
            redirectUri: REDIRECT_URI,
            handshake: { ...prepared.handshake, codeVerifier: 'v' },
        })

        const tokenCall = calls.find((c) => c.url === TOKEN_URL)!
        const tokenBody = bodyOf(tokenCall)
        expect(headersOf(tokenCall).has('authorization')).toBe(false)
        expect(tokenBody.get('client_id')).toBe('cid')
        expect(tokenBody.get('client_secret')).toBe('sec')
    })

    it('falls back to public-client POST when registration omits client_secret even though client_secret_post was requested', async () => {
        const { calls, fetchImpl } = makeFetchRecorder((u) =>
            u === REGISTRATION_URL
                ? registration({ client_id: 'pub-cid' }) // server returned no client_secret
                : token({ access_token: 'tok' }),
        )
        const provider = createDcrProvider<Account>({
            registrationUrl: REGISTRATION_URL,
            authorizeUrl: AUTHORIZE_URL,
            tokenUrl: TOKEN_URL,
            // Configured method asked for client_secret_post — but the registration
            // came back without a secret, so the token request must still drop to
            // public-client POST instead of sending a half-baked credential.
            clientMetadata: { clientName: 'CLI', tokenEndpointAuthMethod: 'client_secret_post' },
            validate,
            fetchImpl,
        })

        const prepared = await provider.prepare!({ redirectUri: REDIRECT_URI, flags: {} })
        expect(prepared.handshake.clientSecret).toBeUndefined()

        await provider.exchangeCode({
            code: 'c',
            state: 's',
            redirectUri: REDIRECT_URI,
            handshake: { ...prepared.handshake, codeVerifier: 'v' },
        })

        const tokenCall = calls.find((c) => c.url === TOKEN_URL)!
        const tokenBody = bodyOf(tokenCall)
        expect(headersOf(tokenCall).has('authorization')).toBe(false)
        expect(tokenBody.get('client_id')).toBe('pub-cid')
        expect(tokenBody.has('client_secret')).toBe(false)
    })

    it("honours the server's token_endpoint_auth_method from the registration response over the configured one (RFC 7591 §3.2.1)", async () => {
        // Configured: client_secret_basic. Server downgrades to client_secret_post.
        // Effective method on the token request must follow the server.
        const { calls, fetchImpl } = makeFetchRecorder((u) =>
            u === REGISTRATION_URL
                ? registration({
                      client_id: 'cid',
                      client_secret: 'sec',
                      token_endpoint_auth_method: 'client_secret_post',
                  })
                : token({ access_token: 'tok' }),
        )
        const provider = createDcrProvider<Account>({
            registrationUrl: REGISTRATION_URL,
            authorizeUrl: AUTHORIZE_URL,
            tokenUrl: TOKEN_URL,
            clientMetadata: { clientName: 'CLI', tokenEndpointAuthMethod: 'client_secret_basic' },
            validate,
            fetchImpl,
        })

        const prepared = await provider.prepare!({ redirectUri: REDIRECT_URI, flags: {} })
        expect(prepared.handshake.tokenEndpointAuthMethod).toBe('client_secret_post')

        await provider.exchangeCode({
            code: 'c',
            state: 's',
            redirectUri: REDIRECT_URI,
            handshake: { ...prepared.handshake, codeVerifier: 'v' },
        })

        const tokenCall = calls.find((c) => c.url === TOKEN_URL)!
        const tokenBody = bodyOf(tokenCall)
        expect(headersOf(tokenCall).has('authorization')).toBe(false)
        expect(tokenBody.get('client_id')).toBe('cid')
        expect(tokenBody.get('client_secret')).toBe('sec')
    })

    it('tokenEndpointAuthMethod=none (or missing client_secret) sends client_id in the body and no Authorization header', async () => {
        const { calls, fetchImpl } = makeFetchRecorder((u) =>
            u === REGISTRATION_URL
                ? registration({ client_id: 'pub-cid' }) // public-client DCR: no client_secret
                : token({ access_token: 'tok-3' }),
        )
        const provider = createDcrProvider<Account>({
            registrationUrl: REGISTRATION_URL,
            authorizeUrl: AUTHORIZE_URL,
            tokenUrl: TOKEN_URL,
            clientMetadata: { clientName: 'CLI', tokenEndpointAuthMethod: 'none' },
            validate,
            fetchImpl,
        })

        const prepared = await provider.prepare!({ redirectUri: REDIRECT_URI, flags: {} })
        expect(prepared.handshake.clientSecret).toBeUndefined()

        await provider.exchangeCode({
            code: 'c',
            state: 's',
            redirectUri: REDIRECT_URI,
            handshake: { ...prepared.handshake, codeVerifier: 'v' },
        })

        const tokenCall = calls.find((c) => c.url === TOKEN_URL)!
        const tokenBody = bodyOf(tokenCall)
        expect(headersOf(tokenCall).has('authorization')).toBe(false)
        expect(tokenBody.get('client_id')).toBe('pub-cid')
        expect(tokenBody.has('client_secret')).toBe(false)
    })

    it('surfaces the server OAuth error from a failed registration as AUTH_DCR_FAILED, hints first', async () => {
        const provider = createDcrProvider<Account>({
            registrationUrl: REGISTRATION_URL,
            authorizeUrl: AUTHORIZE_URL,
            tokenUrl: TOKEN_URL,
            clientMetadata: { clientName: 'CLI' },
            validate,
            errorHints: ['Re-run: cli auth login'],
            fetchImpl: (() =>
                Promise.resolve(respond({ error: 'invalid_redirect_uri' }, 400))) as typeof fetch,
        })
        await expect(
            provider.prepare!({ redirectUri: REDIRECT_URI, flags: {} }),
        ).rejects.toMatchObject({
            code: 'AUTH_DCR_FAILED',
            hints: ['Re-run: cli auth login', 'invalid_redirect_uri'],
        })
    })

    it('DCR response missing client_id or returning non-JSON is AUTH_DCR_FAILED', async () => {
        const make = (fetchImpl: typeof fetch) =>
            createDcrProvider<Account>({
                registrationUrl: REGISTRATION_URL,
                authorizeUrl: AUTHORIZE_URL,
                tokenUrl: TOKEN_URL,
                clientMetadata: { clientName: 'CLI' },
                validate,
                fetchImpl,
            })
        const cases: Array<() => Promise<Response>> = [
            () => Promise.resolve(respond({ scope: 'read' }, 201)), // 201 but no client_id
            () =>
                Promise.resolve(
                    new Response('<html>oops</html>', {
                        status: 201,
                        headers: { 'Content-Type': 'text/html' },
                    }),
                ),
        ]
        for (const fetchImpl of cases) {
            await expect(
                make(fetchImpl as typeof fetch).prepare!({
                    redirectUri: REDIRECT_URI,
                    flags: {},
                }),
            ).rejects.toMatchObject({ code: 'AUTH_DCR_FAILED' })
        }
    })

    it('clientMetadata.extra fields appear in the registration POST body verbatim; named fields win on collisions', async () => {
        const { calls, fetchImpl } = makeFetchRecorder(() => registration({ client_id: 'cid' }))
        const provider = createDcrProvider<Account>({
            registrationUrl: REGISTRATION_URL,
            authorizeUrl: AUTHORIZE_URL,
            tokenUrl: TOKEN_URL,
            clientMetadata: {
                clientName: 'CLI',
                extra: {
                    software_statement: 'eyJhbGciOiJSUzI1NiJ9.test',
                    contacts: ['ops@example.com'],
                    client_name: 'should-be-overridden',
                },
            },
            validate,
            fetchImpl,
        })
        await provider.prepare!({ redirectUri: REDIRECT_URI, flags: {} })
        const body = JSON.parse(calls[0].init.body as string) as Record<string, unknown>
        expect(body.software_statement).toBe('eyJhbGciOiJSUzI1NiJ9.test')
        expect(body.contacts).toEqual(['ops@example.com'])
        expect(body.client_name).toBe('CLI')
    })

    it('maps an oauth4webapi load failure to AUTH_DCR_FAILED, prepending the provider errorHints', async () => {
        // Force the lazy `import('oauth4webapi')` to reject by mocking the
        // module to throw, then re-importing the provider so its memoised
        // import resolves to the throwing mock. (vitest substitutes its own
        // error for a factory throw, so the ERR_MODULE_NOT_FOUND-specific
        // branch isn't reachable here — but the load-failure → AUTH_DCR_FAILED
        // mapping and the errorHints-prepend contract are.)
        vi.resetModules()
        vi.doMock('oauth4webapi', () => {
            throw new Error('boom')
        })
        try {
            const { createDcrProvider: freshCreate } = await import('./dcr.js')
            const provider = freshCreate<Account>({
                registrationUrl: REGISTRATION_URL,
                authorizeUrl: AUTHORIZE_URL,
                tokenUrl: TOKEN_URL,
                clientMetadata: { clientName: 'CLI' },
                validate,
                errorHints: ['Re-run: cli auth login'],
                fetchImpl: (() =>
                    Promise.resolve(registration({ client_id: 'x' }))) as typeof fetch,
            })
            await expect(
                provider.prepare!({ redirectUri: REDIRECT_URI, flags: {} }),
            ).rejects.toMatchObject({
                code: 'AUTH_DCR_FAILED',
                hints: ['Re-run: cli auth login'],
            })
        } finally {
            vi.doUnmock('oauth4webapi')
            vi.resetModules()
        }
    })

    it('fails fast when the registration server selects an unsupported token_endpoint_auth_method', async () => {
        const provider = createDcrProvider<Account>({
            registrationUrl: REGISTRATION_URL,
            authorizeUrl: AUTHORIZE_URL,
            tokenUrl: TOKEN_URL,
            clientMetadata: { clientName: 'CLI' },
            validate,
            fetchImpl: (() =>
                Promise.resolve(
                    registration({
                        client_id: 'cid',
                        client_secret: 'sec',
                        token_endpoint_auth_method: 'private_key_jwt',
                    }),
                )) as typeof fetch,
        })
        await expect(
            provider.prepare!({ redirectUri: REDIRECT_URI, flags: {} }),
        ).rejects.toMatchObject({ code: 'AUTH_DCR_FAILED' })
    })

    it('threads the RFC 8707 resource indicator into the authorize URL and the token request body', async () => {
        const { calls, fetchImpl } = makeFetchRecorder((u) =>
            u === REGISTRATION_URL
                ? registration({ client_id: 'pub' })
                : token({ access_token: 'tok', expires_in: 3600 }),
        )
        const provider = createDcrProvider<Account>({
            registrationUrl: REGISTRATION_URL,
            authorizeUrl: AUTHORIZE_URL,
            tokenUrl: TOKEN_URL,
            resource: 'https://api.example.com',
            clientMetadata: { clientName: 'CLI', tokenEndpointAuthMethod: 'none' },
            validate,
            fetchImpl,
        })

        const prepared = await provider.prepare!({ redirectUri: REDIRECT_URI, flags: {} })
        const authorize = await provider.authorize({
            redirectUri: REDIRECT_URI,
            state: 'state-123',
            scopes: ['user:read'],
            readOnly: false,
            flags: {},
            handshake: prepared.handshake,
        })
        expect(new URL(authorize.authorizeUrl).searchParams.get('resource')).toBe(
            'https://api.example.com',
        )

        await provider.exchangeCode({
            code: 'auth-code',
            state: 'state-123',
            redirectUri: REDIRECT_URI,
            handshake: authorize.handshake,
        })
        const tokenBody = bodyOf(calls.find((c) => c.url === TOKEN_URL)!)
        expect(tokenBody.get('resource')).toBe('https://api.example.com')
    })

    it('refreshToken runs the refresh_token grant, forwarding the resource indicator', async () => {
        const { calls, fetchImpl } = makeFetchRecorder(() =>
            token({ access_token: 'tok-2', refresh_token: 'rt-2', expires_in: 3600 }),
        )
        const provider = createDcrProvider<Account>({
            registrationUrl: REGISTRATION_URL,
            authorizeUrl: AUTHORIZE_URL,
            tokenUrl: TOKEN_URL,
            resource: 'https://api.example.com',
            clientMetadata: { clientName: 'CLI', tokenEndpointAuthMethod: 'none' },
            validate,
            fetchImpl,
        })

        const result = await provider.refreshToken!({
            refreshToken: 'rt-1',
            handshake: { clientId: 'pub' },
        })
        expect(result.accessToken).toBe('tok-2')
        expect(result.refreshToken).toBe('rt-2')
        expect(result.expiresAt).toBeGreaterThan(Date.now())

        const tokenBody = bodyOf(calls.find((c) => c.url === TOKEN_URL)!)
        expect(tokenBody.get('grant_type')).toBe('refresh_token')
        expect(tokenBody.get('refresh_token')).toBe('rt-1')
        expect(tokenBody.get('resource')).toBe('https://api.example.com')
    })

    it('refreshToken authenticates a confidential client per the handshake auth method', async () => {
        const { calls, fetchImpl } = makeFetchRecorder(() => token({ access_token: 'tok' }))
        const provider = createDcrProvider<Account>({
            registrationUrl: REGISTRATION_URL,
            authorizeUrl: AUTHORIZE_URL,
            tokenUrl: TOKEN_URL,
            clientMetadata: { clientName: 'CLI', tokenEndpointAuthMethod: 'client_secret_post' },
            validate,
            fetchImpl,
        })

        await provider.refreshToken!({
            refreshToken: 'rt',
            handshake: {
                clientId: 'cid',
                clientSecret: 'sec',
                tokenEndpointAuthMethod: 'client_secret_post',
            },
        })
        const tokenBody = bodyOf(calls.find((c) => c.url === TOKEN_URL)!)
        expect(tokenBody.get('client_id')).toBe('cid')
        expect(tokenBody.get('client_secret')).toBe('sec')
    })

    it('maps an invalid_grant refresh rejection to AUTH_REFRESH_EXPIRED', async () => {
        const provider = createDcrProvider<Account>({
            registrationUrl: REGISTRATION_URL,
            authorizeUrl: AUTHORIZE_URL,
            tokenUrl: TOKEN_URL,
            clientMetadata: { clientName: 'CLI', tokenEndpointAuthMethod: 'none' },
            validate,
            fetchImpl: (() =>
                Promise.resolve(respond({ error: 'invalid_grant' }, 400))) as typeof fetch,
        })
        await expect(
            provider.refreshToken!({ refreshToken: 'rt', handshake: { clientId: 'pub' } }),
        ).rejects.toMatchObject({ code: 'AUTH_REFRESH_EXPIRED' })
    })

    it('refreshToken without a clientId in the handshake is AUTH_REFRESH_UNAVAILABLE', async () => {
        const provider = createDcrProvider<Account>({
            registrationUrl: REGISTRATION_URL,
            authorizeUrl: AUTHORIZE_URL,
            tokenUrl: TOKEN_URL,
            clientMetadata: { clientName: 'CLI' },
            validate,
            fetchImpl: (() => Promise.resolve(token({ access_token: 'x' }))) as typeof fetch,
        })
        await expect(
            provider.refreshToken!({ refreshToken: 'rt', handshake: {} }),
        ).rejects.toMatchObject({ code: 'AUTH_REFRESH_UNAVAILABLE' })
    })

    it('reuses a cached client via loadClient without a registration POST', async () => {
        const { calls, fetchImpl } = makeFetchRecorder(() => {
            throw new Error('registration must not be called on a cache hit')
        })
        const provider = createDcrProvider<Account>({
            registrationUrl: REGISTRATION_URL,
            authorizeUrl: AUTHORIZE_URL,
            tokenUrl: TOKEN_URL,
            clientMetadata: { clientName: 'CLI' },
            loadClient: () => ({ clientId: 'cached', tokenEndpointAuthMethod: 'none' }),
            validate,
            fetchImpl,
        })

        const prepared = await provider.prepare!({ redirectUri: REDIRECT_URI, flags: {} })
        expect(prepared.handshake).toEqual({
            clientId: 'cached',
            tokenEndpointAuthMethod: 'none',
        })
        expect(calls).toHaveLength(0)
    })

    it('registers and persists a fresh client via saveClient on a cache miss', async () => {
        const saved: DcrRegisteredClient[] = []
        const { calls, fetchImpl } = makeFetchRecorder(() =>
            registration({ client_id: 'fresh', client_secret: 'sec' }),
        )
        const provider = createDcrProvider<Account>({
            registrationUrl: REGISTRATION_URL,
            authorizeUrl: AUTHORIZE_URL,
            tokenUrl: TOKEN_URL,
            clientMetadata: { clientName: 'CLI' },
            loadClient: () => null,
            saveClient: (client) => {
                saved.push(client)
            },
            validate,
            fetchImpl,
        })

        const prepared = await provider.prepare!({ redirectUri: REDIRECT_URI, flags: {} })
        expect(calls).toHaveLength(1)
        expect(prepared.handshake).toEqual({ clientId: 'fresh', clientSecret: 'sec' })
        expect(saved).toEqual([{ clientId: 'fresh', clientSecret: 'sec' }])
    })
})
