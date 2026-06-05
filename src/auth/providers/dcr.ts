import type {
    AuthorizationServer,
    Client,
    ClientAuth,
    TokenEndpointRequestOptions,
} from 'oauth4webapi'

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
    RefreshInput,
    ValidateInput,
} from '../types.js'
import {
    buildAuthError,
    buildPkceAuthorizeUrl,
    expiresAtFromExpiresIn,
    loadOauth4webapi,
    mapRefreshError,
    resolve,
} from './oauth.js'
import type { OAuthLazyString } from './pkce.js'

// Upper bound on the refresh-token POST, mirroring createPkceProvider — kept
// under the refresh helper's stale-lock threshold so a timed-out grant releases
// the lock before another invocation considers it abandoned.
const REFRESH_TIMEOUT_MS = 10_000

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

/**
 * A registered DCR client, as stashed in the handshake by `prepare()` and
 * surfaced to / supplied by the optional caching hooks. The shape a consumer
 * persists to reuse a registration across logins.
 */
export type DcrRegisteredClient = {
    clientId: string
    clientSecret?: string
    /** Server-authoritative method from the registration response, when supported. */
    tokenEndpointAuthMethod?: DcrTokenEndpointAuthMethod
}

export type DcrProviderOptions<TAccount extends AuthAccount = AuthAccount> = {
    /** RFC 7591 registration endpoint. Function form supports per-flow base URLs. */
    registrationUrl: OAuthLazyString
    /** OAuth 2.0 authorize endpoint. */
    authorizeUrl: OAuthLazyString
    /** OAuth 2.0 token endpoint. */
    tokenUrl: OAuthLazyString
    /**
     * RFC 8707 resource indicator. When set, it's appended to the authorize URL
     * and added to the `authorization_code` and `refresh_token` token requests,
     * so the authorization server issues a token whose audience targets this
     * protected resource. Function form supports per-flow resources.
     */
    resource?: OAuthLazyString
    clientMetadata: DcrClientMetadata
    /** How to join scopes in the authorize URL. Default `' '` (RFC 6749). */
    scopeSeparator?: string
    verifierAlphabet?: string
    /** Default 64. */
    verifierLength?: number
    /**
     * Return a previously-registered client to reuse instead of registering a
     * fresh one on every `prepare()`. `null`/`undefined` → register anew. The
     * consumer owns where the client is persisted (config file, keyring, …);
     * pair with `saveClient` to populate that store. cli-core does no caching
     * of its own.
     *
     * IMPORTANT: an RFC 7591 registration is bound to the `redirect_uris` it
     * was registered with, and `runOAuthFlow` can pick a different callback
     * port/path on a later login. Key the cache on `input.redirectUri` (it's
     * provided here) and return a hit only for a matching URI, or the reused
     * client will send an unregistered `redirect_uri` and the authorize call
     * will fail. The returned shape is validated (string `clientId`, supported
     * `tokenEndpointAuthMethod`) before use.
     */
    loadClient?: (
        input: PrepareInput,
    ) => Promise<DcrRegisteredClient | null | undefined> | DcrRegisteredClient | null | undefined
    /**
     * Persist a freshly-registered client so a later `prepare()` can reuse it
     * via `loadClient`. Called only after a successful registration, never on a
     * cache hit. A rejection propagates — handle/swallow inside the hook if a
     * persistence failure shouldn't fail the login.
     */
    saveClient?: (client: DcrRegisteredClient, input: PrepareInput) => Promise<void> | void
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
 *  - `prepare`: reuse a cached client via `loadClient` when supplied, else
 *    register via `dynamicClientRegistrationRequest` (persisting through
 *    `saveClient`). Stash the issued `client_id`, optional `client_secret`, and
 *    the server-returned `token_endpoint_auth_method` (RFC 7591 §3.2.1 — server
 *    is authoritative) in the handshake.
 *  - `authorize`: standard PKCE S256 with `client_id` read from the handshake,
 *    plus the optional RFC 8707 `resource` indicator.
 *  - `exchangeCode`: `authorizationCodeGrantRequest` authenticated per the
 *    handshake's server-returned auth method (falling back to the configured
 *    one) — HTTP Basic (RFC 3986-encoded, see `clientSecretBasicRfc3986`),
 *    client-secret POST, or public-client `None` (the last also when the
 *    registration response carried no `client_secret`). Threads the `resource`
 *    indicator into the token request.
 *  - `refreshToken`: `refreshTokenGrantRequest` with the same client auth and
 *    `resource` as the code exchange, bounded by a 10s timeout. Maps server
 *    rejections onto `AUTH_REFRESH_EXPIRED` / `AUTH_REFRESH_TRANSIENT`.
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
            // Reuse a cached registration when the consumer supplies one — skip
            // the registration round-trip (and the oauth4webapi load) entirely.
            // Validate the persisted shape so a cached client behaves exactly
            // like a freshly registered one rather than failing later in
            // authorize/exchange or silently using the wrong auth method.
            const cached = validateCachedClient(
                options.loadClient ? await options.loadClient(input) : undefined,
                options.errorHints,
            )
            if (cached) {
                return { handshake: clientHandshake(cached) }
            }

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

            const registered: DcrRegisteredClient = { clientId: client.client_id }
            if (typeof client.client_secret === 'string') {
                registered.clientSecret = client.client_secret
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
                registered.tokenEndpointAuthMethod = serverMethod as DcrTokenEndpointAuthMethod
            }
            if (options.saveClient) await options.saveClient(registered, input)
            return { handshake: clientHandshake(registered) }
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
            // Resolve concurrently — both may be async (config read / prompt).
            const [authorizeBaseUrl, resource] = await Promise.all([
                resolve(options.authorizeUrl, input.handshake, input.flags),
                resolveResource(options.resource, input.handshake, input.flags),
            ])
            const authorizeUrl = buildPkceAuthorizeUrl({
                authorizeUrl: authorizeBaseUrl,
                clientId,
                redirectUri: input.redirectUri,
                state: input.state,
                scopes: input.scopes,
                scopeSeparator,
                codeChallenge: challenge,
                additionalParameters: { resource },
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
            const oauth = await loadOauth4webapi({
                code: 'AUTH_TOKEN_EXCHANGE_FAILED',
                missingMessage: 'oauth4webapi is required for the DCR token exchange.',
                userHints: options.errorHints,
                missingHints: MISSING_PEER_HINTS,
            })
            const flags = (input.handshake.flags as Record<string, unknown> | undefined) ?? {}
            const [tokenUrl, resource] = await Promise.all([
                resolve(options.tokenUrl, input.handshake, flags),
                resolveResource(options.resource, input.handshake, flags),
            ])
            const as: AuthorizationServer = { issuer: tokenUrl, token_endpoint: tokenUrl }
            const client: Client = { client_id: clientId }
            const clientAuth = selectClientAuth(oauth, input.handshake, configuredAuthMethod)

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
                    tokenRequestOptions(oauth, options.fetchImpl, resource),
                )
                const result = await oauth.processAuthorizationCodeResponse(as, client, response)
                return {
                    accessToken: result.access_token,
                    refreshToken: result.refresh_token,
                    expiresAt: expiresAtFromExpiresIn(result.expires_in),
                    scope: result.scope,
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

        async refreshToken(input: RefreshInput): Promise<ExchangeResult<TAccount>> {
            // Unlike createPkceProvider (whose clientId is a static provider
            // option), a DCR clientId is minted at registration. cli-core does
            // not persist the handshake — `runOAuthFlow` stores only the token
            // bundle — so the consumer must supply it on the refresh handshake,
            // reconstructed from persisted account metadata, via
            // `refreshAccessToken({ handshake })`. (Confidential clients pass
            // `clientSecret`/`tokenEndpointAuthMethod` the same way.)
            const clientId = input.handshake.clientId
            if (typeof clientId !== 'string') {
                throw buildAuthError(
                    'AUTH_REFRESH_UNAVAILABLE',
                    'DCR refresh requires a clientId on the handshake (reconstruct it from the stored account and pass it via refreshAccessToken({ handshake })).',
                    options.errorHints,
                )
            }
            const oauth = await loadOauth4webapi({
                code: 'AUTH_REFRESH_UNAVAILABLE',
                missingMessage: 'oauth4webapi is required for refresh-token support.',
                userHints: options.errorHints,
                missingHints: MISSING_PEER_HINTS,
            })
            // Mirror `exchangeCode`: a resolver that reads `flags` sees the same
            // view during silent refresh as it did at authorize time.
            const flags = (input.handshake.flags as Record<string, unknown> | undefined) ?? {}
            const [tokenUrl, resource] = await Promise.all([
                resolve(options.tokenUrl, input.handshake, flags),
                resolveResource(options.resource, input.handshake, flags),
            ])
            const as: AuthorizationServer = { issuer: tokenUrl, token_endpoint: tokenUrl }
            const client: Client = { client_id: clientId }
            const clientAuth = selectClientAuth(oauth, input.handshake, configuredAuthMethod)
            // Bound the network call so a hung token endpoint can't hold the
            // refresh lock forever (see createPkceProvider for the rationale).
            const requestOptions = tokenRequestOptions(
                oauth,
                options.fetchImpl,
                resource,
                AbortSignal.timeout(REFRESH_TIMEOUT_MS),
            )
            try {
                const response = await oauth.refreshTokenGrantRequest(
                    as,
                    client,
                    clientAuth,
                    input.refreshToken,
                    requestOptions,
                )
                const result = await oauth.processRefreshTokenResponse(as, client, response)
                return {
                    accessToken: result.access_token,
                    refreshToken: result.refresh_token,
                    expiresAt: expiresAtFromExpiresIn(result.expires_in),
                    scope: result.scope,
                }
            } catch (error) {
                throw mapRefreshError(error, oauth)
            }
        },
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
 * Validate a client returned by `loadClient` before trusting it. A JSON-backed
 * hook can hand back arbitrary shapes; reject a missing/empty `clientId` or an
 * unsupported `tokenEndpointAuthMethod` here so a cached client can't behave
 * differently from a freshly registered one (which the registration path
 * already validates). Returns `undefined` for a cache miss (`null`/`undefined`).
 */
function validateCachedClient(
    cached: DcrRegisteredClient | null | undefined,
    errorHints: string[] | undefined,
): DcrRegisteredClient | undefined {
    if (cached === null || cached === undefined) return undefined
    if (typeof cached.clientId !== 'string' || cached.clientId.length === 0) {
        throw buildAuthError(
            'AUTH_DCR_FAILED',
            'Cached OAuth client is missing a string clientId.',
            errorHints,
        )
    }
    if (
        cached.tokenEndpointAuthMethod !== undefined &&
        !VALID_AUTH_METHODS.has(cached.tokenEndpointAuthMethod)
    ) {
        throw buildAuthError(
            'AUTH_DCR_FAILED',
            `Cached OAuth client has an unsupported token_endpoint_auth_method: ${String(
                cached.tokenEndpointAuthMethod,
            )}.`,
            errorHints,
        )
    }
    return cached
}

/** Resolve the optional RFC 8707 resource indicator, or `undefined` when unset. */
function resolveResource(
    resource: OAuthLazyString | undefined,
    handshake: Record<string, unknown>,
    flags: Record<string, unknown>,
): Promise<string | undefined> {
    return resource ? resolve(resource, handshake, flags) : Promise.resolve(undefined)
}

/** Build the handshake fields a registered (or cached) client contributes. */
function clientHandshake(client: DcrRegisteredClient): Record<string, unknown> {
    const handshake: Record<string, unknown> = { clientId: client.clientId }
    if (client.clientSecret !== undefined) handshake.clientSecret = client.clientSecret
    if (client.tokenEndpointAuthMethod !== undefined) {
        handshake.tokenEndpointAuthMethod = client.tokenEndpointAuthMethod
    }
    return handshake
}

/**
 * Pick the token-endpoint client authentication for `authorization_code` /
 * `refresh_token` grants from the handshake. Server-issued method wins (RFC
 * 7591 §3.2.1), falling back to the configured one. A registration with no
 * `client_secret` can't authenticate Basic/Post regardless of the requested
 * method, so it drops to public-client `None` (POST `client_id` only).
 */
function selectClientAuth(
    oauth: typeof import('oauth4webapi'),
    handshake: Record<string, unknown>,
    configuredAuthMethod: DcrTokenEndpointAuthMethod,
): ClientAuth {
    const clientSecretRaw = handshake.clientSecret
    const clientSecret = typeof clientSecretRaw === 'string' ? clientSecretRaw : undefined
    const issuedMethodRaw = handshake.tokenEndpointAuthMethod
    const issuedMethod: DcrTokenEndpointAuthMethod | undefined =
        typeof issuedMethodRaw === 'string' &&
        VALID_AUTH_METHODS.has(issuedMethodRaw as DcrTokenEndpointAuthMethod)
            ? (issuedMethodRaw as DcrTokenEndpointAuthMethod)
            : undefined
    const effectiveAuthMethod = issuedMethod ?? configuredAuthMethod

    if (!clientSecret || effectiveAuthMethod === 'none') return oauth.None()
    if (effectiveAuthMethod === 'client_secret_post') return oauth.ClientSecretPost(clientSecret)
    return clientSecretBasicRfc3986(clientSecret)
}

/**
 * Assemble the oauth4webapi token-request options: the injected `fetchImpl`
 * (via the `customFetch` symbol), the RFC 8707 `resource` indicator (as an
 * `additionalParameters` body field), and an optional abort `signal`.
 */
function tokenRequestOptions(
    oauth: typeof import('oauth4webapi'),
    fetchImpl: typeof fetch | undefined,
    resource: string | undefined,
    signal?: AbortSignal,
): TokenEndpointRequestOptions {
    const opts: TokenEndpointRequestOptions = {}
    if (fetchImpl) opts[oauth.customFetch] = fetchImpl
    if (resource) opts.additionalParameters = { resource }
    if (signal) opts.signal = signal
    return opts
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
