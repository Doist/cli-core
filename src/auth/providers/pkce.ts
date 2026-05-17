import type { AuthorizationServer, Client, TokenEndpointRequestOptions } from 'oauth4webapi'
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
import { buildAuthError, buildPkceAuthorizeUrl, postTokenEndpoint, resolve } from './_oauth.js'

// Upper bound on the refresh-token POST. Kept under the refresh helper's
// stale-lock threshold so a timed-out grant releases the lock before another
// invocation would consider it abandoned.
const REFRESH_TIMEOUT_MS = 10_000

function expiresAtFromExpiresIn(expiresIn: number | undefined): number | undefined {
    return typeof expiresIn === 'number' ? Date.now() + expiresIn * 1000 : undefined
}

/**
 * Lazy resolver: a literal string, or a function that builds one from the
 * current OAuth handshake (so callers can derive the URL or client_id from
 * the active session's `baseUrl` / per-flow flags). Used by both
 * `createPkceProvider` and `createDcrProvider`; prefer the grant-agnostic
 * alias `OAuthLazyString` for new code.
 */
export type PkceLazyString =
    | string
    | ((ctx: {
          handshake: Record<string, unknown>
          flags: Record<string, unknown>
      }) => string | Promise<string>)

/** Grant-agnostic alias for {@link PkceLazyString}. Identical type. */
export type OAuthLazyString = PkceLazyString

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
    /**
     * User-facing remediation hints attached to every CliError this factory
     * throws (token-endpoint failures, internal handshake-state guards).
     * Server-returned response bodies are appended after these so the
     * actionable hint stays first.
     */
    errorHints?: string[]
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
 * Flows that need DCR or HTTP Basic auth on the token endpoint use
 * `createDcrProvider` (or implement the `AuthProvider` interface directly).
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
            const clientId = await resolve(options.clientId, input.handshake, input.flags)
            const authorizeUrl = buildPkceAuthorizeUrl({
                authorizeUrl: await resolve(options.authorizeUrl, input.handshake, input.flags),
                clientId,
                redirectUri: input.redirectUri,
                state: input.state,
                scopes: input.scopes,
                scopeSeparator,
                codeChallenge: challenge,
            })

            return {
                authorizeUrl,
                handshake: { ...input.handshake, codeVerifier: verifier, clientId },
            }
        },

        async exchangeCode(input: ExchangeInput): Promise<ExchangeResult<TAccount>> {
            const verifier = input.handshake.codeVerifier
            const clientId = input.handshake.clientId
            if (typeof verifier !== 'string' || typeof clientId !== 'string') {
                throw buildAuthError(
                    'AUTH_TOKEN_EXCHANGE_FAILED',
                    'Internal: PKCE handshake state lost between authorize and exchange.',
                    options.errorHints,
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

            const result = await postTokenEndpoint({
                url: tokenUrl,
                body,
                errorHints: options.errorHints,
                fetchImpl,
            })
            return {
                accessToken: result.accessToken,
                refreshToken: result.refreshToken,
                expiresAt: result.expiresAt,
            }
        },

        validateToken: options.validate,

        async refreshToken(input: RefreshInput): Promise<ExchangeResult<TAccount>> {
            const oauth = await loadOauth4webapi()
            // Mirror `exchangeCode`: a resolver that reads `flags` sees the
            // same view during silent refresh as it did at authorize time.
            const flags = (input.handshake.flags as Record<string, unknown> | undefined) ?? {}
            const [tokenUrl, clientId] = await Promise.all([
                resolve(options.tokenUrl, input.handshake, flags),
                resolve(options.clientId, input.handshake, flags),
            ])
            const as: AuthorizationServer = { issuer: tokenUrl, token_endpoint: tokenUrl }
            const client: Client = { client_id: clientId, token_endpoint_auth_method: 'none' }
            // Bound the network call so a hung token endpoint can't block the
            // CLI indefinitely (and, for refresh consumers, can't hold the
            // refresh lock forever). Route through the consumer's injected
            // fetch when present, so a custom transport (proxy dispatcher,
            // decompression) applies to the refresh grant too — oauth4webapi
            // otherwise captures the global `fetch`.
            const requestOptions: TokenEndpointRequestOptions = {
                signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS),
                ...(options.fetchImpl ? { [oauth.customFetch]: options.fetchImpl } : {}),
            }
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
                    expiresAt: expiresAtFromExpiresIn(result.expires_in),
                }
            } catch (error) {
                // A ResponseBodyError carries the server's OAuth error JSON.
                // `invalid_grant` (any status — some proxies remap 400 → 401)
                // means the refresh token itself was rejected; re-login is the
                // only recovery. Every other code is transient from cli-core's
                // POV — but surface the actual `error`/`error_description` so a
                // misconfigured server (e.g. `invalid_request: Missing
                // client_secret`) is diagnosable rather than hidden behind
                // oauth4webapi's generic "server responded with an error".
                if (error instanceof oauth.ResponseBodyError) {
                    const detail = error.error_description
                        ? `${error.error} (${error.error_description})`
                        : error.error
                    if (error.error === 'invalid_grant') {
                        throw new CliError(
                            'AUTH_REFRESH_EXPIRED',
                            `Refresh token rejected: ${detail}`,
                            {
                                hints: ['Re-run the login command to reauthorize.'],
                            },
                        )
                    }
                    throw new CliError(
                        'AUTH_REFRESH_TRANSIENT',
                        `Refresh request failed: ${detail}`,
                        {
                            hints: ['Try again.'],
                        },
                    )
                }
                // Network failure, non-JSON body, WWWAuthenticateChallengeError, …
                throw new CliError(
                    'AUTH_REFRESH_TRANSIENT',
                    `Refresh request failed: ${getErrorMessage(error)}`,
                    { hints: ['Try again.'] },
                )
            }
        },
    }
}

// Optional peer dep — only refresh consumers install it. The dynamic import
// (and a missing-peer failure) is memoised so it isn't repeated on every
// refresh, which sits on the authenticated-call path.
let oauthModulePromise: Promise<typeof import('oauth4webapi')> | undefined

async function loadOauth4webapi(): Promise<typeof import('oauth4webapi')> {
    oauthModulePromise ??= import('oauth4webapi')
    try {
        return await oauthModulePromise
    } catch (error) {
        const code = (error as NodeJS.ErrnoException | undefined)?.code
        if (code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND') {
            throw new CliError(
                'AUTH_REFRESH_UNAVAILABLE',
                'oauth4webapi is required for refresh-token support.',
                { hints: ['Run `npm install oauth4webapi` in your CLI.'] },
            )
        }
        // Installed but failed to initialise — surface the real cause rather
        // than a misleading "install it" hint.
        throw new CliError(
            'AUTH_REFRESH_UNAVAILABLE',
            `Failed to load oauth4webapi: ${getErrorMessage(error)}`,
        )
    }
}
