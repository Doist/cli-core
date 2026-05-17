import { describe, expect, it } from 'vitest'

import { createDcrProvider } from './dcr.js'

type Account = { id: string; label?: string }

const respond = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
    })

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

describe('createDcrProvider', () => {
    it('prepare POSTs RFC 7591 metadata, authorize uses the issued client_id, exchangeCode sends Basic auth', async () => {
        const { calls, fetchImpl } = makeFetchRecorder((u) =>
            u === REGISTRATION_URL
                ? respond({ client_id: 'issued-id', client_secret: 'issued-secret' })
                : respond({ access_token: 'tok-1', expires_in: 3600 }),
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
        expect(prepared.handshake).toEqual({ clientId: 'issued-id', clientSecret: 'issued-secret' })

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
        expect(url.searchParams.get('client_id')).toBe('issued-id')
        expect(url.searchParams.get('redirect_uri')).toBe(REDIRECT_URI)
        expect(url.searchParams.get('state')).toBe('state-123')
        expect(url.searchParams.get('code_challenge_method')).toBe('S256')
        expect(url.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]+$/)
        expect(url.searchParams.get('scope')).toBe('user:read threads:read')
        expect(typeof authorize.handshake.codeVerifier).toBe('string')
        expect(authorize.handshake.clientSecret).toBe('issued-secret')

        const result = await provider.exchangeCode({
            code: 'auth-code',
            state: 'state-123',
            redirectUri: REDIRECT_URI,
            handshake: authorize.handshake,
        })
        expect(result.accessToken).toBe('tok-1')
        expect(result.expiresAt).toBeGreaterThan(Date.now())

        const tokenCall = calls.find((c) => c.url === TOKEN_URL)!
        const tokenHeaders = tokenCall.init.headers as Record<string, string>
        expect(tokenHeaders.Authorization).toBe(
            `Basic ${Buffer.from('issued-id:issued-secret', 'utf8').toString('base64')}`,
        )
        const tokenBody = new URLSearchParams(tokenCall.init.body as string)
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
                ? respond({ client_id: 'cid', client_secret: 'sec' })
                : respond({ access_token: 'tok-2' }),
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
        const tokenHeaders = tokenCall.init.headers as Record<string, string>
        const tokenBody = new URLSearchParams(tokenCall.init.body as string)
        expect(tokenHeaders.Authorization).toBeUndefined()
        expect(tokenBody.get('client_id')).toBe('cid')
        expect(tokenBody.get('client_secret')).toBe('sec')
    })

    it('tokenEndpointAuthMethod=none (or missing client_secret) sends client_id in the body and no Authorization header', async () => {
        const { calls, fetchImpl } = makeFetchRecorder((u) =>
            u === REGISTRATION_URL
                ? respond({ client_id: 'pub-cid' }) // public-client DCR: no client_secret
                : respond({ access_token: 'tok-3' }),
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
        const tokenHeaders = tokenCall.init.headers as Record<string, string>
        const tokenBody = new URLSearchParams(tokenCall.init.body as string)
        expect(tokenHeaders.Authorization).toBeUndefined()
        expect(tokenBody.get('client_id')).toBe('pub-cid')
        expect(tokenBody.has('client_secret')).toBe(false)
    })

    it('DCR non-2xx is AUTH_DCR_FAILED; errorHints are prepended before the body text', async () => {
        const provider = createDcrProvider<Account>({
            registrationUrl: REGISTRATION_URL,
            authorizeUrl: AUTHORIZE_URL,
            tokenUrl: TOKEN_URL,
            clientMetadata: { clientName: 'CLI' },
            validate,
            errorHints: ['Re-run: cli auth login'],
            fetchImpl: (() =>
                Promise.resolve(
                    new Response('invalid_redirect_uri', { status: 400 }),
                )) as typeof fetch,
        })
        await expect(
            provider.prepare!({ redirectUri: REDIRECT_URI, flags: {} }),
        ).rejects.toMatchObject({
            code: 'AUTH_DCR_FAILED',
            hints: ['Re-run: cli auth login', 'invalid_redirect_uri'],
        })
    })

    it('DCR response missing client_id is AUTH_DCR_FAILED', async () => {
        const provider = createDcrProvider<Account>({
            registrationUrl: REGISTRATION_URL,
            authorizeUrl: AUTHORIZE_URL,
            tokenUrl: TOKEN_URL,
            clientMetadata: { clientName: 'CLI' },
            validate,
            fetchImpl: (() => Promise.resolve(respond({ client_secret: 'sec' }))) as typeof fetch,
        })
        await expect(
            provider.prepare!({ redirectUri: REDIRECT_URI, flags: {} }),
        ).rejects.toMatchObject({ code: 'AUTH_DCR_FAILED' })
    })

    it('DCR non-JSON response is AUTH_DCR_FAILED', async () => {
        const provider = createDcrProvider<Account>({
            registrationUrl: REGISTRATION_URL,
            authorizeUrl: AUTHORIZE_URL,
            tokenUrl: TOKEN_URL,
            clientMetadata: { clientName: 'CLI' },
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
            provider.prepare!({ redirectUri: REDIRECT_URI, flags: {} }),
        ).rejects.toMatchObject({ code: 'AUTH_DCR_FAILED' })
    })

    it('token endpoint non-2xx becomes AUTH_TOKEN_EXCHANGE_FAILED', async () => {
        const { fetchImpl } = makeFetchRecorder((u) =>
            u === REGISTRATION_URL
                ? respond({ client_id: 'cid', client_secret: 'sec' })
                : new Response('invalid_grant', { status: 400 }),
        )
        const provider = createDcrProvider<Account>({
            registrationUrl: REGISTRATION_URL,
            authorizeUrl: AUTHORIZE_URL,
            tokenUrl: TOKEN_URL,
            clientMetadata: { clientName: 'CLI' },
            validate,
            fetchImpl,
        })
        const prepared = await provider.prepare!({ redirectUri: REDIRECT_URI, flags: {} })
        await expect(
            provider.exchangeCode({
                code: 'c',
                state: 's',
                redirectUri: REDIRECT_URI,
                handshake: { ...prepared.handshake, codeVerifier: 'v' },
            }),
        ).rejects.toMatchObject({ code: 'AUTH_TOKEN_EXCHANGE_FAILED' })
    })

    it('errorHints are prepended to every error (DCR failure + token-exchange failure), with body text appended on non-2xx', async () => {
        const userHints = ['Re-run: cli auth login', 'Or set CLI_API_TOKEN']

        // DCR non-2xx
        const dcrProvider = createDcrProvider<Account>({
            registrationUrl: REGISTRATION_URL,
            authorizeUrl: AUTHORIZE_URL,
            tokenUrl: TOKEN_URL,
            clientMetadata: { clientName: 'CLI' },
            validate,
            errorHints: userHints,
            fetchImpl: (() =>
                Promise.resolve(new Response('rate_limited', { status: 429 }))) as typeof fetch,
        })
        await expect(
            dcrProvider.prepare!({ redirectUri: REDIRECT_URI, flags: {} }),
        ).rejects.toMatchObject({
            code: 'AUTH_DCR_FAILED',
            hints: [...userHints, 'rate_limited'],
        })

        // DCR missing client_id (no server body to append)
        const noClientIdProvider = createDcrProvider<Account>({
            registrationUrl: REGISTRATION_URL,
            authorizeUrl: AUTHORIZE_URL,
            tokenUrl: TOKEN_URL,
            clientMetadata: { clientName: 'CLI' },
            validate,
            errorHints: userHints,
            fetchImpl: (() => Promise.resolve(respond({}))) as typeof fetch,
        })
        await expect(
            noClientIdProvider.prepare!({ redirectUri: REDIRECT_URI, flags: {} }),
        ).rejects.toMatchObject({ code: 'AUTH_DCR_FAILED', hints: userHints })

        // Token endpoint failure flows through postTokenEndpoint
        const exchangeProvider = createDcrProvider<Account>({
            registrationUrl: REGISTRATION_URL,
            authorizeUrl: AUTHORIZE_URL,
            tokenUrl: TOKEN_URL,
            clientMetadata: { clientName: 'CLI' },
            validate,
            errorHints: userHints,
            fetchImpl: ((url: RequestInfo | URL) =>
                String(url) === REGISTRATION_URL
                    ? Promise.resolve(respond({ client_id: 'cid', client_secret: 'sec' }))
                    : Promise.resolve(
                          new Response('invalid_grant', { status: 400 }),
                      )) as typeof fetch,
        })
        const prepared = await exchangeProvider.prepare!({
            redirectUri: REDIRECT_URI,
            flags: {},
        })
        await expect(
            exchangeProvider.exchangeCode({
                code: 'c',
                state: 's',
                redirectUri: REDIRECT_URI,
                handshake: { ...prepared.handshake, codeVerifier: 'v' },
            }),
        ).rejects.toMatchObject({
            code: 'AUTH_TOKEN_EXCHANGE_FAILED',
            hints: [...userHints, 'invalid_grant'],
        })
    })

    it('clientMetadata.extra fields appear in the registration POST body verbatim; named fields win on collisions', async () => {
        const { calls, fetchImpl } = makeFetchRecorder(() => respond({ client_id: 'cid' }))
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
})
