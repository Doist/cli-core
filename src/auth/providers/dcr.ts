import { CliError } from '../../errors.js'
import { deriveChallenge, generateVerifier } from '../pkce.js'
import type {
    AuthAccount,
    AuthProvider,
    AuthorizeInput,
    AuthorizeResult,
    ExchangeInput,
    ExchangeResult,
    PasteInput,
    PrepareInput,
    PrepareResult,
    ValidateInput,
} from '../types.js'

export type DcrProviderOptions<TAccount extends AuthAccount = AuthAccount> = {
    /** RFC 7591 dynamic client registration endpoint. */
    registerUrl: string
    /** OAuth 2.0 authorize endpoint. */
    authorizeUrl: string
    /** OAuth 2.0 token endpoint. */
    tokenUrl: string
    /** Resolved per-call so `--read-only` and CLI flags can reshape the request. */
    scopes: string[] | ((ctx: { readOnly: boolean; flags: Record<string, unknown> }) => string[])
    /** How to join scopes in the authorize URL. Default `' '`. */
    scopeSeparator?: string
    /** Verifier alphabet override. */
    verifierAlphabet?: string
    /** Verifier length override. Default 64. */
    verifierLength?: number
    /** Extra fields to include in the registration POST body (logo_uri, contacts, …). */
    registrationMetadata?: Record<string, unknown>
    /** `client_name` value sent at registration. */
    clientName: string
    /** `client_uri` value sent at registration. */
    clientUri?: string
    /** Probe an authenticated endpoint to confirm the token works. */
    validate: (input: ValidateInput) => Promise<TAccount>
    /** Optional manual-paste path (e.g. `--token`). Defaults to calling `validate`. */
    acceptPastedToken?: (input: PasteInput) => Promise<TAccount>
    /** Inject a fetch implementation (tests). */
    fetchImpl?: typeof fetch
}

/**
 * Build an `AuthProvider` for the "RFC 7591 dynamic client registration, then
 * PKCE S256 with `client_secret_basic` token-endpoint auth" flow Twist uses.
 *
 * `prepare()` runs the registration POST; the returned `client_id` and
 * `client_secret` are carried in `handshake` through `authorize` (which only
 * needs `client_id`) and `exchangeCode` (which sends both via HTTP Basic).
 *
 * Credentials are *not* persisted — they're ephemeral per login. Storage of
 * the resulting access token is the `TokenStore`'s job.
 */
export function createDcrProvider<TAccount extends AuthAccount>(
    options: DcrProviderOptions<TAccount>,
): AuthProvider<TAccount> {
    const fetchImpl = options.fetchImpl ?? fetch
    const scopeSeparator = options.scopeSeparator ?? ' '

    return {
        async prepare(input: PrepareInput): Promise<PrepareResult> {
            const body: Record<string, unknown> = {
                client_name: options.clientName,
                redirect_uris: [input.redirectUri],
                grant_types: ['authorization_code'],
                response_types: ['code'],
                token_endpoint_auth_method: 'client_secret_basic',
                application_type: 'native',
                ...options.registrationMetadata,
            }
            if (options.clientUri) body.client_uri = options.clientUri

            let response: Response
            try {
                response = await fetchImpl(options.registerUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
                    body: JSON.stringify(body),
                })
            } catch (error) {
                throw new CliError(
                    'AUTH_DCR_FAILED',
                    `Dynamic client registration request failed: ${describe(error)}`,
                )
            }
            if (!response.ok) {
                const detail = await safeReadText(response)
                throw new CliError(
                    'AUTH_DCR_FAILED',
                    `Dynamic client registration returned HTTP ${response.status}.`,
                    detail ? { hints: [detail] } : {},
                )
            }
            const payload = (await response.json()) as {
                client_id?: string
                client_secret?: string
            }
            if (!payload.client_id || !payload.client_secret) {
                throw new CliError(
                    'AUTH_DCR_FAILED',
                    'Registration response missing client_id or client_secret.',
                )
            }
            return {
                handshake: {
                    clientId: payload.client_id,
                    clientSecret: payload.client_secret,
                },
            }
        },

        async authorize(input: AuthorizeInput): Promise<AuthorizeResult> {
            const clientId = input.handshake.clientId
            const clientSecret = input.handshake.clientSecret
            if (typeof clientId !== 'string' || typeof clientSecret !== 'string') {
                throw new CliError(
                    'AUTH_DCR_FAILED',
                    'Internal: DCR handshake missing client_id/client_secret. Did prepare() run?',
                )
            }

            const verifier = generateVerifier({
                alphabet: options.verifierAlphabet,
                length: options.verifierLength,
            })
            const challenge = deriveChallenge(verifier)

            const url = new URL(options.authorizeUrl)
            url.searchParams.set('response_type', 'code')
            url.searchParams.set('client_id', clientId)
            url.searchParams.set('redirect_uri', input.redirectUri)
            url.searchParams.set('state', input.state)
            url.searchParams.set('code_challenge', challenge)
            url.searchParams.set('code_challenge_method', 'S256')
            if (input.scopes.length > 0) {
                url.searchParams.set('scope', input.scopes.join(scopeSeparator))
            }

            return {
                authorizeUrl: url.toString(),
                handshake: { ...input.handshake, codeVerifier: verifier },
            }
        },

        async exchangeCode(input: ExchangeInput): Promise<ExchangeResult<TAccount>> {
            const clientId = input.handshake.clientId
            const clientSecret = input.handshake.clientSecret
            const verifier = input.handshake.codeVerifier
            if (
                typeof clientId !== 'string' ||
                typeof clientSecret !== 'string' ||
                typeof verifier !== 'string'
            ) {
                throw new CliError(
                    'AUTH_TOKEN_EXCHANGE_FAILED',
                    'Internal: DCR handshake state lost between authorize and exchange.',
                )
            }

            const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64')
            const body = new URLSearchParams({
                grant_type: 'authorization_code',
                code: input.code,
                redirect_uri: input.redirectUri,
                code_verifier: verifier,
            })

            let response: Response
            try {
                response = await fetchImpl(options.tokenUrl, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/x-www-form-urlencoded',
                        Authorization: `Basic ${basic}`,
                        Accept: 'application/json',
                    },
                    body: body.toString(),
                })
            } catch (error) {
                throw new CliError(
                    'AUTH_TOKEN_EXCHANGE_FAILED',
                    `Token endpoint request failed: ${describe(error)}`,
                )
            }
            if (!response.ok) {
                const detail = await safeReadText(response)
                throw new CliError(
                    'AUTH_TOKEN_EXCHANGE_FAILED',
                    `Token endpoint returned HTTP ${response.status}.`,
                    detail ? { hints: [detail] } : {},
                )
            }
            const payload = (await response.json()) as {
                access_token?: string
                refresh_token?: string
                expires_in?: number
            }
            if (!payload.access_token) {
                throw new CliError(
                    'AUTH_TOKEN_EXCHANGE_FAILED',
                    'Token endpoint response missing access_token.',
                )
            }
            return {
                accessToken: payload.access_token,
                refreshToken: payload.refresh_token,
                expiresAt:
                    typeof payload.expires_in === 'number'
                        ? Date.now() + payload.expires_in * 1000
                        : undefined,
            }
        },

        validateToken: options.validate,
        acceptPastedToken:
            options.acceptPastedToken ??
            ((input: PasteInput) => options.validate({ token: input.token, handshake: {} })),
    }
}

function describe(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
}

async function safeReadText(response: Response): Promise<string | undefined> {
    try {
        const text = (await response.text()).trim()
        return text.length > 0 ? text : undefined
    } catch {
        return undefined
    }
}
