import type { AuthorizationServer, Client } from 'oauth4webapi'
import { CliError, getErrorMessage } from '../../errors.js'
import { deriveChallenge, generateVerifier } from '../pkce.js'
import type {
    AuthAccount,
    AuthProvider,
    AuthorizeInput,
    AuthorizeResult,
    ExchangeInput,
    ExchangeResult,
    RefreshInput,
    ValidateInput,
} from '../types.js'

/**
 * Lazy resolver: a literal string, or a function that builds one from the
 * current PKCE handshake (so callers can derive the URL or client_id from
 * the active session's `baseUrl` / per-flow flags).
 */
export type PkceLazyString =
    | string
    | ((ctx: {
          handshake: Record<string, unknown>
          flags: Record<string, unknown>
      }) => string | Promise<string>)

export type PkceProviderOptions<TAccount extends AuthAccount = AuthAccount> = {
    /** OAuth 2.0 authorize endpoint. Function form supports per-flow base URLs (Outline self-hosted). */
    authorizeUrl: PkceLazyString
    /** OAuth 2.0 token endpoint. Function form supports per-flow base URLs. */
    tokenUrl: PkceLazyString
    /** Pre-registered client_id, or a function that derives one from `input.flags`. */
    clientId: PkceLazyString
    /** How to join scopes in the authorize URL. Default `' '` (RFC 6749). Pass `','` for Todoist. */
    scopeSeparator?: string
    verifierAlphabet?: string
    /** Default 64. */
    verifierLength?: number
    /** Probe an authenticated endpoint to confirm the token works and resolve the account. */
    validate: (input: ValidateInput) => Promise<TAccount>
    /** Inject a fetch implementation (tests). */
    fetchImpl?: typeof fetch
}

/**
 * Build an `AuthProvider` for the standard "PKCE S256, public client (no
 * client_secret)" flow. Covers Outline (user-supplied client_id + base_url)
 * and Todoist (pre-registered client_id, custom verifier alphabet,
 * comma-separated scope string).
 *
 * The scope list itself is resolved by the caller before invoking
 * `runOAuthFlow` and arrives on `AuthorizeInput.scopes`; this factory does
 * not own scope resolution.
 *
 * Flows that need DCR or HTTP Basic auth on the token endpoint implement
 * the `AuthProvider` interface directly.
 */
export function createPkceProvider<TAccount extends AuthAccount>(
    options: PkceProviderOptions<TAccount>,
): AuthProvider<TAccount> {
    const fetchImpl = options.fetchImpl ?? fetch
    const scopeSeparator = options.scopeSeparator ?? ' '

    return {
        async authorize(input: AuthorizeInput): Promise<AuthorizeResult> {
            const verifier = generateVerifier({
                alphabet: options.verifierAlphabet,
                length: options.verifierLength,
            })
            const challenge = deriveChallenge(verifier)
            const [clientId, authorizeUrl] = await Promise.all([
                resolve(options.clientId, input.handshake, input.flags),
                resolve(options.authorizeUrl, input.handshake, input.flags),
            ])

            const url = new URL(authorizeUrl)
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
                handshake: { ...input.handshake, codeVerifier: verifier, clientId },
            }
        },

        async exchangeCode(input: ExchangeInput): Promise<ExchangeResult<TAccount>> {
            const verifier = input.handshake.codeVerifier
            const clientId = input.handshake.clientId
            if (typeof verifier !== 'string' || typeof clientId !== 'string') {
                throw new CliError(
                    'AUTH_TOKEN_EXCHANGE_FAILED',
                    'Internal: PKCE handshake state lost between authorize and exchange.',
                )
            }
            // `runOAuthFlow` folds the runtime `flags` into the handshake
            // before calling exchange, so a `tokenUrl: ({ flags }) => ...`
            // resolver sees the same flags it saw during authorize.
            const flags = (input.handshake.flags as Record<string, unknown> | undefined) ?? {}
            const tokenUrl = await resolve(options.tokenUrl, input.handshake, flags)

            const body = new URLSearchParams({
                grant_type: 'authorization_code',
                code: input.code,
                redirect_uri: input.redirectUri,
                client_id: clientId,
                code_verifier: verifier,
            })

            let response: Response
            try {
                response = await fetchImpl(tokenUrl, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/x-www-form-urlencoded',
                        Accept: 'application/json',
                    },
                    body: body.toString(),
                })
            } catch (error) {
                throw new CliError(
                    'AUTH_TOKEN_EXCHANGE_FAILED',
                    `Token endpoint request failed: ${getErrorMessage(error)}`,
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

            // Parse defensively — a misconfigured proxy can return a 2xx HTML
            // error page that would otherwise blow up with a raw SyntaxError.
            let payload: { access_token?: string; refresh_token?: string; expires_in?: number }
            try {
                payload = (await response.json()) as typeof payload
            } catch (error) {
                throw new CliError(
                    'AUTH_TOKEN_EXCHANGE_FAILED',
                    `Token endpoint returned non-JSON response: ${getErrorMessage(error)}`,
                )
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

        async refreshToken(input: RefreshInput): Promise<ExchangeResult<TAccount>> {
            const oauth = await loadOauth4webapi()
            const [tokenUrl, clientId] = await Promise.all([
                resolve(options.tokenUrl, input.handshake, {}),
                resolve(options.clientId, input.handshake, {}),
            ])
            const as: AuthorizationServer = { issuer: tokenUrl, token_endpoint: tokenUrl }
            const client: Client = { client_id: clientId, token_endpoint_auth_method: 'none' }
            // Route through the consumer's injected fetch when present, so a
            // custom transport (proxy dispatcher, decompression) applies to
            // the refresh grant too — oauth4webapi otherwise captures the
            // global `fetch`.
            const requestOptions = options.fetchImpl
                ? { [oauth.customFetch]: options.fetchImpl }
                : undefined
            try {
                const response = await oauth.refreshTokenGrantRequest(
                    as,
                    client,
                    oauth.None(),
                    input.refreshToken,
                    requestOptions,
                )
                const result = await oauth.processRefreshTokenResponse(as, client, response)
                return {
                    accessToken: result.access_token,
                    refreshToken: result.refresh_token,
                    expiresAt:
                        typeof result.expires_in === 'number'
                            ? Date.now() + result.expires_in * 1000
                            : undefined,
                }
            } catch (error) {
                // `invalid_grant` (any status — some proxies remap 400 → 401)
                // is the only retryable-by-relogin signal; everything else
                // (network, 5xx, non-JSON, other OAuth error codes) is
                // transient from cli-core's POV.
                if (error instanceof oauth.ResponseBodyError && error.error === 'invalid_grant') {
                    throw new CliError(
                        'AUTH_REFRESH_EXPIRED',
                        `Refresh token rejected: ${error.error_description ?? error.error}`,
                        { hints: ['Re-run the login command to reauthorize.'] },
                    )
                }
                throw new CliError(
                    'AUTH_REFRESH_TRANSIENT',
                    `Refresh request failed: ${getErrorMessage(error)}`,
                    { hints: ['Try again.'] },
                )
            }
        },
    }
}

async function resolve(
    resolver: PkceLazyString,
    handshake: Record<string, unknown>,
    flags: Record<string, unknown>,
): Promise<string> {
    return typeof resolver === 'function' ? resolver({ handshake, flags }) : resolver
}

// Optional peer dep — only refresh consumers install it.
async function loadOauth4webapi(): Promise<typeof import('oauth4webapi')> {
    try {
        return await import('oauth4webapi')
    } catch {
        throw new CliError(
            'AUTH_REFRESH_UNAVAILABLE',
            'oauth4webapi is required for refresh-token support.',
            { hints: ['Run `npm install oauth4webapi` in your CLI.'] },
        )
    }
}

async function safeReadText(response: Response): Promise<string | undefined> {
    try {
        const text = (await response.text()).trim()
        return text.length > 0 ? text : undefined
    } catch {
        return undefined
    }
}
