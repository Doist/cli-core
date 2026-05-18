import { CliError, type CliErrorCode, getErrorMessage } from '../../errors.js'
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

type TokenEndpointPayload = {
    access_token?: string
    refresh_token?: string
    expires_in?: number
    error?: string
}

/**
 * Build an `AuthProvider` for the standard "PKCE S256, public client (no
 * client_secret)" flow. Covers Outline (user-supplied client_id + base_url)
 * and Todoist (pre-registered client_id, custom verifier alphabet,
 * comma-separated scope string).
 *
 * Implements `exchangeCode` (authorization_code grant) and `refreshToken`
 * (refresh_token grant). Both POSTs share `postToTokenEndpoint` so the
 * fetch + error handling + JSON-parsing logic lives in exactly one place.
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
            const flags = (input.handshake.flags as Record<string, unknown> | undefined) ?? {}
            const tokenUrl = resolve(options.tokenUrl, input.handshake, flags)

            const body = new URLSearchParams({
                grant_type: 'authorization_code',
                code: input.code,
                redirect_uri: input.redirectUri,
                client_id: clientId,
                code_verifier: verifier,
            })

            const payload = await postToTokenEndpoint({
                fetchImpl,
                tokenUrl,
                body,
                errorCode: 'AUTH_TOKEN_EXCHANGE_FAILED',
                label: 'Token',
            })

            return {
                accessToken: payload.access_token!,
                refreshToken: payload.refresh_token,
                expiresAt:
                    typeof payload.expires_in === 'number'
                        ? Date.now() + payload.expires_in * 1000
                        : undefined,
            }
        },

        async refreshToken(input: RefreshInput<TAccount>): Promise<ExchangeResult<TAccount>> {
            // At refresh time there is no PKCE codeVerifier — the access
            // token has already been issued, and the refresh grant doesn't
            // re-prove the user. We do still need the clientId (public OAuth
            // client) and tokenUrl, both resolved from the synthesised
            // handshake on the stored account.
            const flags = (input.handshake.flags as Record<string, unknown> | undefined) ?? {}
            const tokenUrl = resolve(options.tokenUrl, input.handshake, flags)
            const clientId = resolve(options.clientId, input.handshake, flags)

            const body = new URLSearchParams({
                grant_type: 'refresh_token',
                refresh_token: input.refreshToken,
                client_id: clientId,
            })

            const payload = await postToTokenEndpoint({
                fetchImpl,
                tokenUrl,
                body,
                // 400/401 + `invalid_grant` is the spec signal that the
                // refresh token itself is revoked/expired. We tunnel that
                // discriminator through the helper via `classifyErrorStatus`
                // so the caller code stays one return path.
                errorCode: 'AUTH_REFRESH_TRANSIENT',
                label: 'Refresh token',
                classifyErrorStatus: (status, detail) =>
                    (status === 400 || status === 401) && /invalid_grant/i.test(detail ?? '')
                        ? 'AUTH_REFRESH_EXPIRED'
                        : 'AUTH_REFRESH_TRANSIENT',
            })

            return {
                accessToken: payload.access_token!,
                refreshToken: payload.refresh_token,
                expiresAt:
                    typeof payload.expires_in === 'number'
                        ? Date.now() + payload.expires_in * 1000
                        : undefined,
                account: input.account,
            }
        },

        validateToken: options.validate,
    }
}

function resolve(
    resolver: PkceLazyString,
    handshake: Record<string, unknown>,
    flags: Record<string, unknown>,
): string {
    return typeof resolver === 'function' ? resolver({ handshake, flags }) : resolver
}

type PostOptions = {
    fetchImpl: typeof fetch
    tokenUrl: string
    body: URLSearchParams
    /** Error code used for network failures, 5xx, non-JSON, and missing access_token. */
    errorCode: CliErrorCode
    /** Human label for error messages ("Token", "Refresh token"). */
    label: string
    /**
     * For 4xx responses where the body discriminates the error type (e.g.
     * `invalid_grant` on a refresh). Returning a different code routes the
     * thrown `CliError` to a different recovery path in the caller.
     */
    classifyErrorStatus?: (status: number, detail: string | undefined) => CliErrorCode
}

/**
 * Shared OAuth token-endpoint POST. Used by both `exchangeCode` and
 * `refreshToken` so the fetch + status handling + JSON parsing logic is
 * defined once. Always-JSON content type, urlencoded body, no auth header
 * (PKCE = public client).
 */
async function postToTokenEndpoint(options: PostOptions): Promise<TokenEndpointPayload> {
    let response: Response
    try {
        response = await options.fetchImpl(options.tokenUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                Accept: 'application/json',
            },
            body: options.body.toString(),
        })
    } catch (error) {
        throw new CliError(
            options.errorCode,
            `${options.label} endpoint request failed: ${getErrorMessage(error)}`,
        )
    }

    if (!response.ok) {
        const detail = await safeReadText(response)
        const code = options.classifyErrorStatus
            ? options.classifyErrorStatus(response.status, detail)
            : options.errorCode
        throw new CliError(
            code,
            `${options.label} endpoint returned HTTP ${response.status}.`,
            detail ? { hints: [detail] } : {},
        )
    }

    let payload: TokenEndpointPayload
    try {
        payload = (await response.json()) as TokenEndpointPayload
    } catch (error) {
        throw new CliError(
            options.errorCode,
            `${options.label} endpoint returned non-JSON response: ${getErrorMessage(error)}`,
        )
    }
    if (!payload.access_token) {
        throw new CliError(
            options.errorCode,
            `${options.label} endpoint response missing access_token.`,
        )
    }
    return payload
}

async function safeReadText(response: Response): Promise<string | undefined> {
    try {
        const text = (await response.text()).trim()
        return text.length > 0 ? text : undefined
    } catch {
        return undefined
    }
}
