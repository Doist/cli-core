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
    postAndParseJson,
    postTokenEndpoint,
    resolve,
} from './_oauth.js'
import type { PkceLazyString } from './pkce.js'

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
    registrationUrl: PkceLazyString
    /** OAuth 2.0 authorize endpoint. */
    authorizeUrl: PkceLazyString
    /** OAuth 2.0 token endpoint. */
    tokenUrl: PkceLazyString
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
     * response bodies are appended after these so the actionable hint stays
     * first.
     */
    errorHints?: string[]
    /** Inject a fetch implementation (tests). */
    fetchImpl?: typeof fetch
}

const VALID_AUTH_METHODS: ReadonlySet<DcrTokenEndpointAuthMethod> = new Set([
    'client_secret_basic',
    'client_secret_post',
    'none',
])

/**
 * Build an `AuthProvider` for the RFC 7591 Dynamic Client Registration flow.
 *
 *  - `prepare`: POST `clientMetadata` to `registrationUrl`. Stash the issued
 *    `client_id`, optional `client_secret`, and the server-returned
 *    `token_endpoint_auth_method` (RFC 7591 §3.2.1 — server is authoritative)
 *    in the handshake.
 *  - `authorize`: standard PKCE S256 with `client_id` read from the handshake.
 *  - `exchangeCode`: token endpoint POST, authenticated per the handshake's
 *    server-returned auth method (falling back to the configured one) —
 *    Basic auth header for `client_secret_basic`, secret in the body for
 *    `client_secret_post`, neither for `none` (or when the registration
 *    response carried no `client_secret`).
 *  - `validateToken`: caller-supplied.
 */
export function createDcrProvider<TAccount extends AuthAccount>(
    options: DcrProviderOptions<TAccount>,
): AuthProvider<TAccount> {
    const fetchImpl = options.fetchImpl ?? fetch
    const scopeSeparator = options.scopeSeparator ?? ' '
    const configuredAuthMethod: DcrTokenEndpointAuthMethod =
        options.clientMetadata.tokenEndpointAuthMethod ?? 'client_secret_basic'

    return {
        async prepare(input: PrepareInput): Promise<PrepareResult> {
            const registrationUrl = await resolve(options.registrationUrl, {}, input.flags)
            const registrationBody = buildRegistrationBody(
                options.clientMetadata,
                input.redirectUri,
                configuredAuthMethod,
            )

            const payload = await postAndParseJson<{
                client_id?: string
                client_secret?: string
                token_endpoint_auth_method?: string
            }>({
                url: registrationUrl,
                headers: {
                    'Content-Type': 'application/json',
                    Accept: 'application/json',
                },
                body: JSON.stringify(registrationBody),
                errorCode: 'AUTH_DCR_FAILED',
                errorLabel: 'Registration endpoint',
                errorHints: options.errorHints,
                fetchImpl,
            })

            if (!payload.client_id) {
                throw buildAuthError(
                    'AUTH_DCR_FAILED',
                    'Registration response missing client_id.',
                    options.errorHints,
                )
            }

            const handshake: Record<string, unknown> = { clientId: payload.client_id }
            if (payload.client_secret) handshake.clientSecret = payload.client_secret
            // Per RFC 7591 §3.2.1 the server may downgrade or override the
            // requested method. Only persist values we know how to act on;
            // an unknown method falls back to the configured one at exchange.
            if (
                typeof payload.token_endpoint_auth_method === 'string' &&
                VALID_AUTH_METHODS.has(
                    payload.token_endpoint_auth_method as DcrTokenEndpointAuthMethod,
                )
            ) {
                handshake.tokenEndpointAuthMethod = payload.token_endpoint_auth_method
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

            const flags = (input.handshake.flags as Record<string, unknown> | undefined) ?? {}
            const tokenUrl = await resolve(options.tokenUrl, input.handshake, flags)

            const body = new URLSearchParams({
                grant_type: 'authorization_code',
                code: input.code,
                redirect_uri: input.redirectUri,
                code_verifier: verifier,
            })

            // Public-client fallback: a registration with no `client_secret`
            // can't authenticate Basic/Post regardless of the requested method,
            // so we POST `client_id` in the body like a non-confidential
            // client. Otherwise honour the effective auth method.
            let basicAuth: { clientId: string; clientSecret: string } | undefined
            if (!clientSecret || effectiveAuthMethod === 'none') {
                body.set('client_id', clientId)
            } else if (effectiveAuthMethod === 'client_secret_post') {
                body.set('client_id', clientId)
                body.set('client_secret', clientSecret)
            } else {
                basicAuth = { clientId, clientSecret }
            }

            const result = await postTokenEndpoint({
                url: tokenUrl,
                body,
                basicAuth,
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
    }
}

function buildRegistrationBody(
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
