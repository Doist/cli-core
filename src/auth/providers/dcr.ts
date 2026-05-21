import type { AuthorizationServer, Client, ClientAuth } from 'oauth4webapi'

import { getErrorMessage } from '../../errors.js'
import type { CliError } from '../../errors.js'
import type { AuthErrorCode } from '../errors.js'
import { deriveChallenge, generateVerifier } from '../pkce.js'
import type {
    AuthAccount,
    AuthProvider,
    AuthorizeInput,
    AuthorizeResult,
    ExchangeInput,
    ExchangeResult,
    PrepareInput,
    PrepareResult,
    ValidateInput,
} from '../types.js'
import {
    buildAuthError,
    buildPkceAuthorizeUrl,
    expiresAtFromExpiresIn,
    loadOauth4webapi,
    resolve,
} from './oauth.js'
import type { OAuthLazyString } from './pkce.js'

export type DcrTokenEndpointAuthMethod = 'client_secret_basic' | 'client_secret_post' | 'none'

/**
 * RFC 7591 Dynamic Client Registration metadata POSTed to the registration
 * endpoint. Only fields the CLI typically cares about are named; pass anything
 * else (`software_statement`, `jwks`, …) via `extra`.
 */
export type DcrClientMetadata = {
    clientName: string
    clientUri?: string
    logoUri?: string
    applicationType?: 'native' | 'web'
    /**
     * Requested token-endpoint auth method. Defaults to `'client_secret_basic'`.
     * The registration response is authoritative per RFC 7591 §3.2.1 — when
     * the server returns its own `token_endpoint_auth_method`, that value
     * wins over this configured one.
     */
    tokenEndpointAuthMethod?: DcrTokenEndpointAuthMethod
    /** Defaults to `['authorization_code']`. */
    grantTypes?: string[]
    /** Defaults to `['code']`. */
    responseTypes?: string[]
    /** Merged verbatim into the registration POST body. */
    extra?: Record<string, unknown>
}

export type DcrProviderOptions<TAccount extends AuthAccount = AuthAccount> = {
    /** RFC 7591 registration endpoint. Function form supports per-flow base URLs. */
    registrationUrl: OAuthLazyString
    /** OAuth 2.0 authorize endpoint. */
    authorizeUrl: OAuthLazyString
    /** OAuth 2.0 token endpoint. */
    tokenUrl: OAuthLazyString
    clientMetadata: DcrClientMetadata
    /** How to join scopes in the authorize URL. Default `' '` (RFC 6749). */
    scopeSeparator?: string
    verifierAlphabet?: string
    /** Default 64. */
    verifierLength?: number
    /** Probe an authenticated endpoint to confirm the token works and resolve the account. */
    validate: (input: ValidateInput) => Promise<TAccount>
    /**
     * User-facing remediation hints attached to every CliError this factory
     * throws (`AUTH_DCR_FAILED` from `prepare()` / `authorize()` and
     * `AUTH_TOKEN_EXCHANGE_FAILED` from `exchangeCode()`). Server-returned
     * error details are appended after these so the actionable hint stays
     * first.
     */
    errorHints?: string[]
    /** Inject a fetch implementation (tests / custom transport). */
    fetchImpl?: typeof fetch
}

const MISSING_PEER_HINTS = ['Run `npm install oauth4webapi` in your CLI.']

const VALID_AUTH_METHODS: ReadonlySet<DcrTokenEndpointAuthMethod> = new Set([
    'client_secret_basic',
    'client_secret_post',
    'none',
])

/**
 * Build an `AuthProvider` for the RFC 7591 Dynamic Client Registration flow,
 * driven by [`oauth4webapi`](https://github.com/panva/oauth4webapi) (an
 * optional peer dep — installed only by DCR/refresh consumers).
 *
 *  - `prepare`: register via `dynamicClientRegistrationRequest`. Stash the
 *    issued `client_id`, optional `client_secret`, and the server-returned
 *    `token_endpoint_auth_method` (RFC 7591 §3.2.1 — server is authoritative)
 *    in the handshake.
 *  - `authorize`: standard PKCE S256 with `client_id` read from the handshake.
 *  - `exchangeCode`: `authorizationCodeGrantRequest` authenticated per the
 *    handshake's server-returned auth method (falling back to the configured
 *    one) — HTTP Basic (RFC 3986-encoded, see `clientSecretBasicRfc3986`),
 *    client-secret POST, or public-client `None` (the last also when the
 *    registration response carried no `client_secret`).
 *  - `validateToken`: caller-supplied.
 */
export function createDcrProvider<TAccount extends AuthAccount>(
    options: DcrProviderOptions<TAccount>,
): AuthProvider<TAccount> {
    const scopeSeparator = options.scopeSeparator ?? ' '
    const configuredAuthMethod: DcrTokenEndpointAuthMethod =
        options.clientMetadata.tokenEndpointAuthMethod ?? 'client_secret_basic'

    return {
        async prepare(input: PrepareInput): Promise<PrepareResult> {
            const oauth = await loadOauth4webapi({
                code: 'AUTH_DCR_FAILED',
                missingMessage: 'oauth4webapi is required for Dynamic Client Registration.',
                userHints: options.errorHints,
                missingHints: MISSING_PEER_HINTS,
            })
            const registrationUrl = await resolve(options.registrationUrl, {}, input.flags)
            const as: AuthorizationServer = {
                issuer: registrationUrl,
                registration_endpoint: registrationUrl,
            }
            const metadata = buildRegistrationMetadata(
                options.clientMetadata,
                input.redirectUri,
                configuredAuthMethod,
            )

            let client: Client
            try {
                const response = await oauth.dynamicClientRegistrationRequest(
                    as,
                    metadata as Parameters<typeof oauth.dynamicClientRegistrationRequest>[1],
                    customFetchOptions(oauth, options.fetchImpl),
                )
                client = await oauth.processDynamicClientRegistrationResponse(response)
            } catch (error) {
                throw mapOauthError(
                    error,
                    oauth,
                    'AUTH_DCR_FAILED',
                    'Dynamic Client Registration failed.',
                    options.errorHints,
                )
            }

            const handshake: Record<string, unknown> = { clientId: client.client_id }
            if (typeof client.client_secret === 'string') {
                handshake.clientSecret = client.client_secret
            }
            // Per RFC 7591 §3.2.1 the server's chosen method is authoritative.
            // Honour a supported one; fail fast on a method we can't perform
            // (e.g. `private_key_jwt`) rather than silently authenticating the
            // token request with the wrong scheme.
            const serverMethod = client.token_endpoint_auth_method
            if (typeof serverMethod === 'string') {
                if (!VALID_AUTH_METHODS.has(serverMethod as DcrTokenEndpointAuthMethod)) {
                    throw buildAuthError(
                        'AUTH_DCR_FAILED',
                        `Registration server selected an unsupported token_endpoint_auth_method: ${serverMethod}.`,
                        options.errorHints,
                    )
                }
                handshake.tokenEndpointAuthMethod = serverMethod
            }
            return { handshake }
        },

        async authorize(input: AuthorizeInput): Promise<AuthorizeResult> {
            const clientId = input.handshake.clientId
            if (typeof clientId !== 'string') {
                throw buildAuthError(
                    'AUTH_DCR_FAILED',
                    'Internal: DCR handshake missing clientId before authorize.',
                    options.errorHints,
                )
            }

            const verifier = generateVerifier({
                alphabet: options.verifierAlphabet,
                length: options.verifierLength,
            })
            const challenge = deriveChallenge(verifier)
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
                handshake: { ...input.handshake, codeVerifier: verifier },
            }
        },

        async exchangeCode(input: ExchangeInput): Promise<ExchangeResult<TAccount>> {
            const verifier = input.handshake.codeVerifier
            const clientId = input.handshake.clientId
            if (typeof verifier !== 'string' || typeof clientId !== 'string') {
                throw buildAuthError(
                    'AUTH_TOKEN_EXCHANGE_FAILED',
                    'Internal: DCR handshake state lost between authorize and exchange.',
                    options.errorHints,
                )
            }
            const clientSecretRaw = input.handshake.clientSecret
            const clientSecret = typeof clientSecretRaw === 'string' ? clientSecretRaw : undefined
            const issuedMethodRaw = input.handshake.tokenEndpointAuthMethod
            const issuedMethod: DcrTokenEndpointAuthMethod | undefined =
                typeof issuedMethodRaw === 'string' &&
                VALID_AUTH_METHODS.has(issuedMethodRaw as DcrTokenEndpointAuthMethod)
                    ? (issuedMethodRaw as DcrTokenEndpointAuthMethod)
                    : undefined
            // Server-issued method wins (RFC 7591 §3.2.1). Fall back to the
            // configured one only when the server didn't echo a known method.
            const effectiveAuthMethod = issuedMethod ?? configuredAuthMethod

            const oauth = await loadOauth4webapi({
                code: 'AUTH_TOKEN_EXCHANGE_FAILED',
                missingMessage: 'oauth4webapi is required for the DCR token exchange.',
                userHints: options.errorHints,
                missingHints: MISSING_PEER_HINTS,
            })
            const flags = (input.handshake.flags as Record<string, unknown> | undefined) ?? {}
            const tokenUrl = await resolve(options.tokenUrl, input.handshake, flags)
            const as: AuthorizationServer = { issuer: tokenUrl, token_endpoint: tokenUrl }
            const client: Client = { client_id: clientId }

            // Public-client fallback: a registration with no `client_secret`
            // can't authenticate Basic/Post regardless of the requested method,
            // so we POST `client_id` like a non-confidential client. Otherwise
            // honour the effective auth method.
            let clientAuth: ClientAuth
            if (!clientSecret || effectiveAuthMethod === 'none') {
                clientAuth = oauth.None()
            } else if (effectiveAuthMethod === 'client_secret_post') {
                clientAuth = oauth.ClientSecretPost(clientSecret)
            } else {
                clientAuth = clientSecretBasicRfc3986(clientSecret)
            }

            try {
                // The flow runtime owns CSRF state validation; skip oauth4webapi's
                // own state check (it only brands the params for the grant call).
                const callbackParameters = oauth.validateAuthResponse(
                    as,
                    client,
                    new URLSearchParams({ code: input.code }),
                    oauth.skipStateCheck,
                )
                const response = await oauth.authorizationCodeGrantRequest(
                    as,
                    client,
                    clientAuth,
                    callbackParameters,
                    input.redirectUri,
                    verifier,
                    customFetchOptions(oauth, options.fetchImpl),
                )
                const result = await oauth.processAuthorizationCodeResponse(as, client, response)
                return {
                    accessToken: result.access_token,
                    refreshToken: result.refresh_token,
                    expiresAt: expiresAtFromExpiresIn(result.expires_in),
                }
            } catch (error) {
                throw mapOauthError(
                    error,
                    oauth,
                    'AUTH_TOKEN_EXCHANGE_FAILED',
                    'Token exchange failed.',
                    options.errorHints,
                )
            }
        },

        validateToken: options.validate,
    }
}

/**
 * HTTP Basic client auth that percent-encodes each credential component with
 * `encodeURIComponent` (RFC 3986) rather than oauth4webapi's stricter RFC 6749
 * §2.3.1 `application/x-www-form-urlencoded` form. Both escape the genuinely
 * reserved chars (`:` `%` `+` `/` …) so a conformant server reconstructs them —
 * but §2.3.1 *also* escapes the unreserved `-` `_` `.` `~`, which breaks servers
 * that don't url-decode the Basic credential (a DCR-issued `twd_…` would arrive
 * as `twd%5F…` and miss the lookup). Leaving those unreserved chars intact keeps
 * such servers working while still transmitting reserved chars safely.
 */
function clientSecretBasicRfc3986(clientSecret: string): ClientAuth {
    return (_as, client, _body, headers) => {
        const credentials = Buffer.from(
            `${encodeURIComponent(client.client_id)}:${encodeURIComponent(clientSecret)}`,
            'utf8',
        ).toString('base64')
        headers.set('authorization', `Basic ${credentials}`)
    }
}

/** Thread an injected `fetchImpl` into oauth4webapi via its `customFetch` symbol. */
function customFetchOptions(
    oauth: typeof import('oauth4webapi'),
    fetchImpl: typeof fetch | undefined,
): { [k: symbol]: typeof fetch } | undefined {
    return fetchImpl ? { [oauth.customFetch]: fetchImpl } : undefined
}

/**
 * Translate an oauth4webapi failure into a typed `CliError`. A `ResponseBodyError`
 * carries the server's OAuth error JSON (`error` / `error_description`) — surface
 * it so a misconfigured server is diagnosable. Everything else (non-conform
 * status, non-JSON body, network failure) collapses to the raw message.
 */
function mapOauthError(
    error: unknown,
    oauth: typeof import('oauth4webapi'),
    code: AuthErrorCode,
    message: string,
    hints: string[] | undefined,
): CliError {
    if (error instanceof oauth.ResponseBodyError) {
        const detail = error.error_description
            ? `${error.error} (${error.error_description})`
            : error.error
        return buildAuthError(code, message, hints, detail)
    }
    return buildAuthError(code, message, hints, getErrorMessage(error))
}

function buildRegistrationMetadata(
    metadata: DcrClientMetadata,
    redirectUri: string,
    tokenEndpointAuthMethod: DcrTokenEndpointAuthMethod,
): Record<string, unknown> {
    const body: Record<string, unknown> = {
        ...metadata.extra,
        client_name: metadata.clientName,
        redirect_uris: [redirectUri],
        grant_types: metadata.grantTypes ?? ['authorization_code'],
        response_types: metadata.responseTypes ?? ['code'],
        token_endpoint_auth_method: tokenEndpointAuthMethod,
    }
    if (metadata.clientUri) body.client_uri = metadata.clientUri
    if (metadata.logoUri) body.logo_uri = metadata.logoUri
    if (metadata.applicationType) body.application_type = metadata.applicationType
    return body
}
