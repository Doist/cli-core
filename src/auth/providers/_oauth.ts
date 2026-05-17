import { CliError, getErrorMessage } from '../../errors.js'
import type { AuthErrorCode } from '../errors.js'
import type { PkceLazyString } from './pkce.js'

/**
 * Build a `CliError` with user-supplied `errorHints` prepended and an optional
 * server-derived `extra` detail appended. Centralises the "user-actionable
 * first, diagnostic second" ordering used everywhere in this directory.
 */
export function buildAuthError(
    code: AuthErrorCode,
    message: string,
    userHints: string[] | undefined,
    extra?: string,
): CliError {
    const hints = [...(userHints ?? []), ...(extra ? [extra] : [])]
    return new CliError(code, message, hints.length > 0 ? { hints } : {})
}

/**
 * Resolve a literal-or-function endpoint/clientId against the current handshake
 * and runtime flags. Used by every provider in this directory.
 */
export async function resolve(
    resolver: PkceLazyString,
    handshake: Record<string, unknown>,
    flags: Record<string, unknown>,
): Promise<string> {
    return typeof resolver === 'function' ? resolver({ handshake, flags }) : resolver
}

/** Read a response body without letting a stream error escape — used for hints. */
export async function safeReadText(response: Response): Promise<string | undefined> {
    try {
        const text = (await response.text()).trim()
        return text.length > 0 ? text : undefined
    } catch {
        return undefined
    }
}

export type BuildPkceAuthorizeUrlInput = {
    authorizeUrl: string
    clientId: string
    redirectUri: string
    state: string
    scopes: string[]
    scopeSeparator: string
    codeChallenge: string
}

/** Construct the standard PKCE S256 authorize URL. */
export function buildPkceAuthorizeUrl(input: BuildPkceAuthorizeUrlInput): string {
    const url = new URL(input.authorizeUrl)
    url.searchParams.set('response_type', 'code')
    url.searchParams.set('client_id', input.clientId)
    url.searchParams.set('redirect_uri', input.redirectUri)
    url.searchParams.set('state', input.state)
    url.searchParams.set('code_challenge', input.codeChallenge)
    url.searchParams.set('code_challenge_method', 'S256')
    if (input.scopes.length > 0) {
        url.searchParams.set('scope', input.scopes.join(input.scopeSeparator))
    }
    return url.toString()
}

/**
 * Per RFC 6749 §2.3.1, the `client_id` and `client_secret` MUST be
 * `application/x-www-form-urlencoded`-encoded before being concatenated with
 * a colon for HTTP Basic Authentication. A literal colon (or any reserved
 * character) in either value would otherwise corrupt the credential.
 */
export function encodeBasicAuth(clientId: string, clientSecret: string): string {
    return Buffer.from(
        `${encodeURIComponent(clientId)}:${encodeURIComponent(clientSecret)}`,
        'utf8',
    ).toString('base64')
}

export type PostAndParseJsonInput = {
    url: string
    headers: Record<string, string>
    /** Pre-encoded request body. */
    body: string
    /** Error code wrapped around every failure mode. */
    errorCode: AuthErrorCode
    /** Prefix for error messages, e.g. `'Token endpoint'` or `'Registration endpoint'`. */
    errorLabel: string
    errorHints?: string[]
    fetchImpl: typeof fetch
}

/**
 * POST a request, parse a JSON response, and wrap every failure mode as a
 * typed `CliError`. Common backbone for the OAuth token endpoint and the
 * RFC 7591 dynamic-client-registration endpoint — both POST a body, both
 * expect a JSON reply, both want uniform error handling.
 *
 * Throws `errorCode` with the configured hints on:
 *   - network failure (fetch rejection)
 *   - non-2xx response (body text appended as a hint after `errorHints`)
 *   - non-JSON 2xx body (a misconfigured proxy returning HTML, etc.)
 *
 * Success-shape validation (e.g. `access_token` present) is the caller's
 * job, because it differs per endpoint.
 */
export async function postAndParseJson<T>(input: PostAndParseJsonInput): Promise<T> {
    const fail = (message: string, extra?: string): CliError =>
        buildAuthError(input.errorCode, message, input.errorHints, extra)

    let response: Response
    try {
        response = await input.fetchImpl(input.url, {
            method: 'POST',
            headers: input.headers,
            body: input.body,
        })
    } catch (error) {
        throw fail(`${input.errorLabel} request failed: ${getErrorMessage(error)}`)
    }

    if (!response.ok) {
        const detail = await safeReadText(response)
        throw fail(`${input.errorLabel} returned HTTP ${response.status}.`, detail)
    }

    // Parse defensively — a misconfigured proxy can return a 2xx HTML error
    // page that would otherwise blow up with a raw SyntaxError.
    try {
        return (await response.json()) as T
    } catch (error) {
        throw fail(`${input.errorLabel} returned non-JSON response: ${getErrorMessage(error)}`)
    }
}

export type PostTokenEndpointInput = {
    url: string
    /** Form-encoded body. Caller owns grant_type + grant-specific params. */
    body: URLSearchParams
    /** When present, sent as `Authorization: Basic base64(clientId:clientSecret)`. */
    basicAuth?: { clientId: string; clientSecret: string }
    /**
     * User-facing remediation hints attached to every `CliError` this helper
     * throws (network failure, non-2xx, parse failure, missing access_token).
     * The server-returned response body (for non-2xx) is appended after these
     * so user hints stay at the top.
     */
    errorHints?: string[]
    fetchImpl: typeof fetch
}

export type PostTokenEndpointResult = {
    accessToken: string
    refreshToken?: string
    /** Unix-epoch ms. Computed from `expires_in` when the server returns it. */
    expiresAt?: number
}

/**
 * POST to an OAuth 2.0 token endpoint and parse the standard JSON response.
 * The same shape covers `authorization_code` (PKCE / DCR exchange) and
 * `refresh_token` grants — the caller picks the grant by populating `body`.
 *
 * Failures uniformly throw `CliError('AUTH_TOKEN_EXCHANGE_FAILED', …)`:
 * network errors, non-2xx responses (with body text as a hint), non-JSON
 * bodies, and responses missing `access_token`.
 */
export async function postTokenEndpoint(
    input: PostTokenEndpointInput,
): Promise<PostTokenEndpointResult> {
    const headers: Record<string, string> = {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
    }
    if (input.basicAuth) {
        headers.Authorization = `Basic ${encodeBasicAuth(input.basicAuth.clientId, input.basicAuth.clientSecret)}`
    }

    const payload = await postAndParseJson<{
        access_token?: string
        refresh_token?: string
        expires_in?: number
    }>({
        url: input.url,
        headers,
        body: input.body.toString(),
        errorCode: 'AUTH_TOKEN_EXCHANGE_FAILED',
        errorLabel: 'Token endpoint',
        errorHints: input.errorHints,
        fetchImpl: input.fetchImpl,
    })
    if (!payload.access_token) {
        throw buildAuthError(
            'AUTH_TOKEN_EXCHANGE_FAILED',
            'Token endpoint response missing access_token.',
            input.errorHints,
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
}
