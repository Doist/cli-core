import { CliError } from '../../errors.js'
import { deriveChallenge, generateVerifier } from '../pkce.js'
import type {
    AuthAccount,
    AuthProvider,
    AuthorizeInput,
    AuthorizeResult,
    ExchangeInput,
    ExchangeResult,
    ValidateInput,
} from '../types.js'

export type PkceUrlResolver = string | ((ctx: { handshake: Record<string, unknown> }) => string)

export type ScopeResolver =
    | string[]
    | ((ctx: { readOnly: boolean; flags: Record<string, unknown> }) => string[])

export type PkceProviderOptions<TAccount extends AuthAccount = AuthAccount> = {
    /** OAuth 2.0 authorize endpoint. Function form supports per-flow base URLs (Outline self-hosted). */
    authorizeUrl: PkceUrlResolver
    /** OAuth 2.0 token endpoint. Function form supports per-flow base URLs. */
    tokenUrl: PkceUrlResolver
    /** Pre-registered client_id. Function form supports caller-provided values via flags. */
    clientId: string | ((ctx: { flags: Record<string, unknown> }) => string)
    /** Resolved per-call so `--read-only` and CLI flags can reshape the request. */
    scopes: ScopeResolver
    /** How to join scopes in the authorize URL. Default `' '` (RFC 6749). Pass `','` for Todoist. */
    scopeSeparator?: string
    /** Verifier alphabet override (Todoist uses a 64-char subset). */
    verifierAlphabet?: string
    /** Verifier length override. Default 64. */
    verifierLength?: number
    /**
     * Probe an authenticated endpoint to confirm the token works and resolve
     * the account record we'll persist.
     */
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
 * Flows that need a per-login Dynamic Client Registration step or HTTP Basic
 * auth on the token endpoint can implement the `AuthProvider` interface
 * directly until cli-core grows a dedicated factory for them.
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
            const clientId = resolveClientId(options.clientId, input.flags)
            const authorizeUrl = resolveUrl(options.authorizeUrl, input.handshake)

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
            const tokenUrl = resolveUrl(options.tokenUrl, input.handshake)

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
                    `Token endpoint request failed: ${describe(error)}`,
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

            const payload = (await response.json()) as {
                access_token?: string
                refresh_token?: string
                expires_in?: number
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
    }
}

function resolveUrl(resolver: PkceUrlResolver, handshake: Record<string, unknown>): string {
    return typeof resolver === 'function' ? resolver({ handshake }) : resolver
}

function resolveClientId(
    resolver: PkceProviderOptions['clientId'],
    flags: Record<string, unknown>,
): string {
    return typeof resolver === 'function' ? resolver({ flags }) : resolver
}

function describe(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
}

async function safeReadText(response: Response): Promise<string | undefined> {
    try {
        const text = (await response.text()).trim()
        return text.length > 0 ? text : undefined
    } catch {
        return undefined
    }
}
