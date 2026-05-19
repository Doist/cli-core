import type { AuthorizationServer, Client, TokenEndpointResponse } from 'oauth4webapi'
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
    | ((ctx: { handshake: Record<string, unknown>; flags: Record<string, unknown> }) => string)

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
            const clientId = resolve(options.clientId, input.handshake, input.flags)
            const authorizeUrl = resolve(options.authorizeUrl, input.handshake, input.flags)

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
            const tokenUrl = resolve(options.tokenUrl, input.handshake, flags)

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
            // RefreshInput.handshake is empty by default; the helper has no
            // flags context during silent rotation, so resolvers that need
            // per-flow flags should encode the relevant state in the
            // handshake the caller supplies (or be constant).
            const flags = (input.handshake.flags as Record<string, unknown> | undefined) ?? {}
            const tokenUrlResolved = resolve(options.tokenUrl, input.handshake, flags)
            const clientIdResolved = resolve(options.clientId, input.handshake, flags)
            const as: AuthorizationServer = {
                issuer: tokenUrlResolved,
                token_endpoint: tokenUrlResolved,
            }
            const client: Client = {
                client_id: clientIdResolved,
                token_endpoint_auth_method: 'none',
            }
            try {
                const response = await oauth.refreshTokenGrantRequest(
                    as,
                    client,
                    oauth.None(),
                    input.refreshToken,
                )
                const result = await oauth.processRefreshTokenResponse(as, client, response)
                return mapRefreshResponse<TAccount>(result)
            } catch (error) {
                throw translateRefreshError(oauth, error)
            }
        },
    }
}

function resolve(
    resolver: PkceLazyString,
    handshake: Record<string, unknown>,
    flags: Record<string, unknown>,
): string {
    return typeof resolver === 'function' ? resolver({ handshake, flags }) : resolver
}

/**
 * Lazy-import `oauth4webapi`. It's an optional peer dep — only refresh
 * consumers install it. Missing module → `AUTH_REFRESH_UNAVAILABLE` with an
 * actionable hint; any other import failure rethrows as `CliError` of the
 * same code (the user can't recover beyond "install the dep" either way).
 */
type Oauth4WebApi = typeof import('oauth4webapi')

async function loadOauth4webapi(): Promise<Oauth4WebApi> {
    try {
        return await import('oauth4webapi')
    } catch (error) {
        const code = (error as NodeJS.ErrnoException | undefined)?.code
        if (code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND') {
            throw new CliError(
                'AUTH_REFRESH_UNAVAILABLE',
                'oauth4webapi is required for refresh-token support.',
                { hints: ['Run `npm install oauth4webapi` in your CLI.'] },
            )
        }
        throw new CliError(
            'AUTH_REFRESH_UNAVAILABLE',
            `Failed to load oauth4webapi: ${getErrorMessage(error)}`,
        )
    }
}

function mapRefreshResponse<TAccount extends AuthAccount>(
    response: TokenEndpointResponse,
): ExchangeResult<TAccount> {
    return {
        accessToken: response.access_token,
        refreshToken: response.refresh_token,
        expiresAt:
            typeof response.expires_in === 'number'
                ? Date.now() + response.expires_in * 1000
                : undefined,
    }
}

/**
 * Translate `oauth4webapi` failures to the typed refresh contract.
 *
 * - `ResponseBodyError` with `error === 'invalid_grant'` → `AUTH_REFRESH_EXPIRED`
 *   regardless of status (some reverse proxies remap 400 → 401).
 * - Everything else (other `ResponseBodyError` codes, network failures, 5xx,
 *   non-JSON bodies, `WWWAuthenticateChallengeError`) → `AUTH_REFRESH_TRANSIENT`.
 */
function translateRefreshError(oauth: Oauth4WebApi, error: unknown): CliError {
    if (error instanceof CliError) return error
    if (error instanceof oauth.ResponseBodyError && error.error === 'invalid_grant') {
        return new CliError(
            'AUTH_REFRESH_EXPIRED',
            `Refresh token rejected: ${error.error_description ?? error.error}`,
            { hints: ['Re-run the login command to reauthorize.'] },
        )
    }
    return new CliError(
        'AUTH_REFRESH_TRANSIENT',
        `Refresh request failed: ${getErrorMessage(error)}`,
        { hints: ['Try again.'] },
    )
}

async function safeReadText(response: Response): Promise<string | undefined> {
    try {
        const text = (await response.text()).trim()
        return text.length > 0 ? text : undefined
    } catch {
        return undefined
    }
}
