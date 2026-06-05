import { CliError, getErrorMessage } from '../../errors.js'
import type { AuthErrorCode } from '../errors.js'
import type { OAuthLazyString } from './pkce.js'

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
    resolver: OAuthLazyString,
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

type BuildPkceAuthorizeUrlInput = {
    authorizeUrl: string
    clientId: string
    redirectUri: string
    state: string
    scopes: string[]
    scopeSeparator: string
    codeChallenge: string
    /**
     * Extra query parameters appended to the authorize URL, e.g. the RFC 8707
     * `resource` indicator. Set after the standard PKCE params, so a caller
     * can't accidentally clobber `client_id`/`state`/etc. `undefined` values
     * are skipped.
     */
    additionalParameters?: Record<string, string | undefined>
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
    for (const [key, value] of Object.entries(input.additionalParameters ?? {})) {
        if (value !== undefined) url.searchParams.set(key, value)
    }
    return url.toString()
}

type PostAndParseJsonInput = {
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

type PostTokenEndpointInput = {
    url: string
    /** Form-encoded body. Caller owns grant_type + grant-specific params. */
    body: URLSearchParams
    /**
     * User-facing remediation hints attached to every `CliError` this helper
     * throws (network failure, non-2xx, parse failure, missing access_token).
     * The server-returned response body (for non-2xx) is appended after these
     * so user hints stay at the top.
     */
    errorHints?: string[]
    fetchImpl: typeof fetch
}

type PostTokenEndpointResult = {
    accessToken: string
    refreshToken?: string
    /** Unix-epoch ms. Computed from `expires_in` when the server returns it. */
    expiresAt?: number
}

/**
 * POST to an OAuth 2.0 token endpoint and parse the standard JSON response.
 * Covers the public-client `authorization_code` exchange (PKCE) — the caller
 * owns `grant_type` and the grant-specific params via `body`.
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
        expiresAt: expiresAtFromExpiresIn(payload.expires_in),
    }
}

/** Convert an OAuth `expires_in` (seconds from now) into a Unix-epoch ms deadline. */
export function expiresAtFromExpiresIn(expiresIn: number | undefined): number | undefined {
    return typeof expiresIn === 'number' ? Date.now() + expiresIn * 1000 : undefined
}

/**
 * Map a `refreshTokenGrantRequest` failure onto the refresh error taxonomy,
 * shared by every provider that exposes `refreshToken`. A `ResponseBodyError`
 * carries the server's OAuth error JSON: `invalid_grant` (any status — some
 * proxies remap 400 → 401) means the refresh token itself was rejected, so
 * re-login is the only recovery (`AUTH_REFRESH_EXPIRED`). Every other code is
 * transient from cli-core's POV (`AUTH_REFRESH_TRANSIENT`) — but the actual
 * `error`/`error_description` is surfaced so a misconfigured server is
 * diagnosable rather than hidden behind a generic message.
 */
export function mapRefreshError(error: unknown, oauth: typeof import('oauth4webapi')): CliError {
    if (error instanceof oauth.ResponseBodyError) {
        const detail = error.error_description
            ? `${error.error} (${error.error_description})`
            : error.error
        if (error.error === 'invalid_grant') {
            return new CliError('AUTH_REFRESH_EXPIRED', `Refresh token rejected: ${detail}`, {
                hints: ['Re-run the login command to reauthorize.'],
            })
        }
        return new CliError('AUTH_REFRESH_TRANSIENT', `Refresh request failed: ${detail}`, {
            hints: ['Try again.'],
        })
    }
    // Network failure, non-JSON body, WWWAuthenticateChallengeError, …
    return new CliError(
        'AUTH_REFRESH_TRANSIENT',
        `Refresh request failed: ${getErrorMessage(error)}`,
        {
            hints: ['Try again.'],
        },
    )
}

// Optional peer dep — only DCR and refresh consumers install it. The dynamic
// import (and a missing-peer failure) is memoised so it isn't repeated on every
// call that sits on the authenticated-call path.
let oauthModulePromise: Promise<typeof import('oauth4webapi')> | undefined

type LoadOauthOptions = {
    /** Error code wrapped around a missing/broken peer dep. */
    code: AuthErrorCode
    /** Message when the peer dep isn't installed. */
    missingMessage: string
    /** Caller-supplied remediation hints (e.g. provider `errorHints`), prepended first. */
    userHints?: string[]
    /** Install hint for the missing-peer case, appended after `userHints`. */
    missingHints?: string[]
}

/**
 * Lazily import `oauth4webapi`, surfacing a typed `CliError` when the optional
 * peer dep is absent (vs. installed-but-broken). Shared by `createPkceProvider`
 * (refresh) and `createDcrProvider` (registration + token exchange). Caller
 * `userHints` are prepended on both failure branches so the provider's
 * `errorHints` contract holds even when the dep is missing.
 */
export async function loadOauth4webapi(
    options: LoadOauthOptions,
): Promise<typeof import('oauth4webapi')> {
    oauthModulePromise ??= import('oauth4webapi')
    try {
        return await oauthModulePromise
    } catch (error) {
        const moduleCode = (error as NodeJS.ErrnoException | undefined)?.code
        if (moduleCode === 'ERR_MODULE_NOT_FOUND' || moduleCode === 'MODULE_NOT_FOUND') {
            const hints = [...(options.userHints ?? []), ...(options.missingHints ?? [])]
            throw new CliError(
                options.code,
                options.missingMessage,
                hints.length > 0 ? { hints } : {},
            )
        }
        // Installed but failed to initialise — surface the real cause rather
        // than a misleading "install it" hint.
        throw buildAuthError(
            options.code,
            `Failed to load oauth4webapi: ${getErrorMessage(error)}`,
            options.userHints,
        )
    }
}
