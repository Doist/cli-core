import { getErrorMessage } from '../../errors.js'
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
    postTokenEndpoint,
    resolve,
    safeReadText,
} from './_oauth.js'
import type { PkceLazyString } from './pkce.js'

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
    /** How the token endpoint will be authenticated. Defaults to `'client_secret_basic'`. */
    tokenEndpointAuthMethod?: 'client_secret_basic' | 'client_secret_post' | 'none'
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

/**
 * Build an `AuthProvider` for the RFC 7591 Dynamic Client Registration flow.
 *
 *  - `prepare`: POST `clientMetadata` to `registrationUrl`. Stash the issued
 *    `client_id` (and `client_secret` if returned) in the handshake.
 *  - `authorize`: standard PKCE S256 with `client_id` read from the handshake.
 *  - `exchangeCode`: token endpoint POST, authenticated per the metadata's
 *    `tokenEndpointAuthMethod` — Basic auth header for `client_secret_basic`,
 *    secret in the body for `client_secret_post`, neither for `none` (or when
 *    the registration response carried no `client_secret`).
 *  - `validateToken`: caller-supplied.
 */
export function createDcrProvider<TAccount extends AuthAccount>(
    options: DcrProviderOptions<TAccount>,
): AuthProvider<TAccount> {
    const fetchImpl = options.fetchImpl ?? fetch
    const scopeSeparator = options.scopeSeparator ?? ' '
    const tokenEndpointAuthMethod =
        options.clientMetadata.tokenEndpointAuthMethod ?? 'client_secret_basic'

    return {
        async prepare(input: PrepareInput): Promise<PrepareResult> {
            const registrationUrl = await resolve(options.registrationUrl, {}, input.flags)
            const registrationBody = buildRegistrationBody(
                options.clientMetadata,
                input.redirectUri,
                tokenEndpointAuthMethod,
            )

            const fail = (message: string, extra?: string) =>
                buildAuthError('AUTH_DCR_FAILED', message, options.errorHints, extra)

            let response: Response
            try {
                response = await fetchImpl(registrationUrl, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        Accept: 'application/json',
                    },
                    body: JSON.stringify(registrationBody),
                })
            } catch (error) {
                throw fail(`Registration endpoint request failed: ${getErrorMessage(error)}`)
            }

            if (!response.ok) {
                const detail = await safeReadText(response)
                throw fail(`Registration endpoint returned HTTP ${response.status}.`, detail)
            }

            let payload: { client_id?: string; client_secret?: string }
            try {
                payload = (await response.json()) as typeof payload
            } catch (error) {
                throw fail(
                    `Registration endpoint returned non-JSON response: ${getErrorMessage(error)}`,
                )
            }
            if (!payload.client_id) {
                throw fail('Registration response missing client_id.')
            }

            const handshake: Record<string, unknown> = { clientId: payload.client_id }
            if (payload.client_secret) handshake.clientSecret = payload.client_secret
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
            // client. Otherwise honour the configured auth method.
            let basicAuth: { clientId: string; clientSecret: string } | undefined
            if (!clientSecret || tokenEndpointAuthMethod === 'none') {
                body.set('client_id', clientId)
            } else if (tokenEndpointAuthMethod === 'client_secret_post') {
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
    tokenEndpointAuthMethod: NonNullable<DcrClientMetadata['tokenEndpointAuthMethod']>,
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
