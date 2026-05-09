import { CliError } from '../errors.js'
import { isStdoutTTY } from '../terminal.js'
import { startCallbackServer } from './callback-server.js'
import { generateState } from './pkce.js'
import type {
    AuthAccount,
    AuthProvider,
    ErrorContext,
    SuccessContext,
    TokenStore,
} from './types.js'

export type RunOAuthFlowOptions<TAccount extends AuthAccount = AuthAccount> = {
    provider: AuthProvider<TAccount>
    store: TokenStore<TAccount>
    /** Display name passed to renderSuccess/renderError contexts. */
    displayName: string
    /** Resolved scope list to request. */
    scopes: string[]
    /** Was `--read-only` set? Threaded through to the provider. */
    readOnly: boolean
    /** Per-CLI flags from the command line (Commander option object). */
    flags: Record<string, unknown>
    /** Preferred local callback port. */
    preferredPort: number
    /** Walk up this many sequential ports if `preferredPort` is busy. Default 5. */
    portFallbackCount?: number
    /** Callback path the OAuth provider redirects to. Default `'/callback'`. */
    callbackPath?: string
    /** HTML returned to the browser on success. */
    renderSuccess: (ctx: SuccessContext) => string
    /** HTML returned to the browser on failure. */
    renderError: (ctx: ErrorContext) => string
    /** Override the browser opener (tests). When omitted, dynamically imports `open`. */
    openBrowser?: (url: string) => Promise<void>
    /** Print the authorize URL to stdout as a fallback when the browser can't open it. */
    onAuthorizeUrl?: (url: string) => void
    /** Callback timeout in ms. Default 3 minutes. */
    timeoutMs?: number
    /** Cancellation signal (Ctrl-C wiring). */
    signal?: AbortSignal
}

export type RunOAuthFlowResult<TAccount extends AuthAccount = AuthAccount> = {
    token: string
    account: TAccount
}

/**
 * Run the standard OAuth dance end-to-end and persist the resulting token.
 *
 * Steps:
 *  1. `provider.prepare?(…)` — optional pre-flight (DCR, …).
 *  2. `startCallbackServer(…)` — binds the local port (with fallback walk).
 *  3. `provider.authorize(…)` — returns the URL we'll send the user to.
 *  4. Open the browser. If that fails or stdout is a TTY, also print the URL
 *     so the user can click it manually.
 *  5. `server.waitForCallback(…)` — blocks until the user returns or the
 *     timeout fires.
 *  6. `provider.exchangeCode(…)` — code → tokens.
 *  7. `provider.validateToken(…)` — probes an authenticated endpoint to
 *     resolve the account (skipped when exchangeCode already returned one).
 *  8. `store.set(account, token)` + `store.setActive(account.id)`.
 */
export async function runOAuthFlow<TAccount extends AuthAccount>(
    options: RunOAuthFlowOptions<TAccount>,
): Promise<RunOAuthFlowResult<TAccount>> {
    const state = generateState()
    let prepareHandshake: Record<string, unknown> = {}

    // Build a placeholder redirectUri for prepare(); rewritten once the
    // server actually binds. Most prepare implementations only need the
    // *port* range, not the literal URL — Twist sends the redirect URI in
    // the registration payload but rejects it later if it doesn't match the
    // authorize call, so we resolve the real port first.
    const server = await startCallbackServer({
        preferredPort: options.preferredPort,
        portFallbackCount: options.portFallbackCount,
        path: options.callbackPath,
        expectedState: state,
        renderSuccess: options.renderSuccess,
        renderError: options.renderError,
        displayName: options.displayName,
    })

    const cleanup = async () => {
        await server.stop()
    }

    let abortListener: (() => void) | null = null
    if (options.signal) {
        abortListener = () => {
            void cleanup()
        }
        options.signal.addEventListener('abort', abortListener)
    }

    try {
        if (options.signal?.aborted) {
            throw new CliError('AUTH_OAUTH_FAILED', 'Authorization aborted before it started.')
        }

        if (options.provider.prepare) {
            const prepared = await options.provider.prepare({
                redirectUri: server.redirectUri,
                flags: options.flags,
            })
            prepareHandshake = prepared.handshake
        }

        const authorize = await options.provider.authorize({
            redirectUri: server.redirectUri,
            state,
            scopes: options.scopes,
            readOnly: options.readOnly,
            flags: options.flags,
            handshake: prepareHandshake,
        })

        await openOrFallback(authorize.authorizeUrl, options)

        const callback = await server.waitForCallback(options.timeoutMs)

        const exchange = await options.provider.exchangeCode({
            code: callback.code,
            state: callback.state,
            redirectUri: server.redirectUri,
            handshake: authorize.handshake,
        })

        const account =
            exchange.account ??
            (await options.provider.validateToken({
                token: exchange.accessToken,
                handshake: authorize.handshake,
            }))

        await options.store.set(account, exchange.accessToken)
        await options.store.setActive(account.id)

        return { token: exchange.accessToken, account }
    } finally {
        if (options.signal && abortListener) {
            options.signal.removeEventListener('abort', abortListener)
        }
        await cleanup()
    }
}

async function openOrFallback(
    url: string,
    options: RunOAuthFlowOptions<AuthAccount>,
): Promise<void> {
    const print = () => {
        if (options.onAuthorizeUrl) options.onAuthorizeUrl(url)
        else if (isStdoutTTY()) console.log(`Open this URL in your browser:\n  ${url}`)
    }

    const opener = options.openBrowser ?? (await loadDefaultOpener())
    if (!opener) {
        print()
        return
    }
    try {
        await opener(url)
        // Always print as a fallback aid — some browsers silently fail to
        // focus or the user may want to copy the URL anyway.
        print()
    } catch {
        print()
    }
}

async function loadDefaultOpener(): Promise<((url: string) => Promise<void>) | null> {
    try {
        const mod = (await import('open')) as { default: (url: string) => Promise<unknown> }
        return async (url: string) => {
            await mod.default(url)
        }
    } catch {
        return null
    }
}
