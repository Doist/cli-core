import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http'
import { CliError, getErrorMessage } from '../errors.js'
import { isStdoutTTY } from '../terminal.js'
import { generateState } from './pkce.js'
import type { AuthAccount, AuthProvider, TokenStore } from './types.js'

// WSL's `open` package routes through `xdg-open` / `wslview`, both of which
// silently no-op on headless WSL installs — the spawn resolves cleanly but no
// browser ever appears, so the OAuth callback wait runs to its 3-minute
// timeout. Detect at call time and route WSL through `cmd.exe` directly.
// Non-Linux platforms short-circuit before the fs read.
function isWsl(): boolean {
    if (process.platform !== 'linux') return false
    try {
        return /microsoft/i.test(readFileSync('/proc/version', 'utf8'))
    } catch {
        return false
    }
}

// SSH sessions, containers, CI runners, headless servers — same failure mode
// as WSL but with no Windows side to bounce through. With no DISPLAY /
// WAYLAND_DISPLAY (and no $BROWSER override for Codespaces-style setups
// that route through a remote bridge), `xdg-open` will either error or
// no-op, so the spawn is pure noise — skip it and let the URL print do the
// work.
function isHeadlessLinux(): boolean {
    if (process.platform !== 'linux') return false
    if (process.env.BROWSER) return false
    return !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY
}

export type RunOAuthFlowOptions<TAccount extends AuthAccount = AuthAccount> = {
    provider: AuthProvider<TAccount>
    store: TokenStore<TAccount>
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
    /** Bind address. Default `'127.0.0.1'`. */
    callbackHost?: string
    /** HTML returned to the browser on success. */
    renderSuccess: () => string
    /** HTML returned to the browser on failure. Receives the OAuth error description. */
    renderError: (message: string) => string
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

const DEFAULT_PORT_FALLBACK_COUNT = 5
const DEFAULT_CALLBACK_TIMEOUT_MS = 3 * 60 * 1000
const DEFAULT_CALLBACK_PATH = '/callback'
const DEFAULT_CALLBACK_HOST = '127.0.0.1'

/**
 * Drive the OAuth dance end-to-end and persist the resulting token.
 *
 * `prepare?` → bind callback server → `authorize` → open browser →
 * wait for callback → `exchangeCode` → `validateToken?` → `store.set`.
 * (`validateToken` is skipped when `exchangeCode` already returned an
 * `account`.)
 *
 * Aborting `signal` throws `AUTH_OAUTH_FAILED`. A timeout throws
 * `AUTH_CALLBACK_TIMEOUT`. Bind failures throw `AUTH_PORT_BIND_FAILED`.
 *
 * The local HTTP callback server is an internal implementation detail; it
 * is not a separately reusable module since OAuth login is its only
 * consumer today.
 */
export async function runOAuthFlow<TAccount extends AuthAccount>(
    options: RunOAuthFlowOptions<TAccount>,
): Promise<RunOAuthFlowResult<TAccount>> {
    assertValidPort(options.preferredPort, 'preferredPort')

    const state = generateState()
    let prepareHandshake: Record<string, unknown> = {}

    const server = await startCallbackServer({
        preferredPort: options.preferredPort,
        portFallbackCount: options.portFallbackCount ?? DEFAULT_PORT_FALLBACK_COUNT,
        path: options.callbackPath ?? DEFAULT_CALLBACK_PATH,
        host: options.callbackHost ?? DEFAULT_CALLBACK_HOST,
        expectedState: state,
        renderSuccess: options.renderSuccess,
        renderError: options.renderError,
    })

    let abortListener: (() => void) | null = null
    if (options.signal) {
        abortListener = () => {
            void server.stop()
        }
        options.signal.addEventListener('abort', abortListener)
    }

    const checkAborted = (): void => {
        if (options.signal?.aborted) {
            throw new CliError('AUTH_OAUTH_FAILED', 'Authorization aborted.')
        }
    }

    try {
        checkAborted()

        if (options.provider.prepare) {
            const prepared = await options.provider.prepare({
                redirectUri: server.redirectUri,
                flags: options.flags,
            })
            prepareHandshake = prepared.handshake
            checkAborted()
        }

        const authorize = await options.provider.authorize({
            redirectUri: server.redirectUri,
            state,
            scopes: options.scopes,
            readOnly: options.readOnly,
            flags: options.flags,
            handshake: prepareHandshake,
        })
        checkAborted()

        await openOrFallback(authorize.authorizeUrl, options)

        const callback = await server.waitForCallback(
            options.timeoutMs ?? DEFAULT_CALLBACK_TIMEOUT_MS,
        )
        checkAborted()

        // Merge prepareHandshake into the downstream handshake so prepare-time
        // state survives even when a custom provider's authorize() forgets to
        // forward it. Then fold the runtime `flags` and `readOnly` into the
        // handshake so providers' `exchangeCode` / `validateToken` get the
        // same view that `authorize` had — the typed input fields don't
        // carry them, and stuffing them here keeps consumer providers from
        // having to re-thread them manually.
        const downstreamHandshake: Record<string, unknown> = {
            ...prepareHandshake,
            ...authorize.handshake,
            flags: options.flags,
            readOnly: options.readOnly,
        }

        const exchange = await options.provider.exchangeCode({
            code: callback.code,
            state: callback.state,
            redirectUri: server.redirectUri,
            handshake: downstreamHandshake,
        })
        checkAborted()

        const account =
            exchange.account ??
            (await options.provider.validateToken({
                token: exchange.accessToken,
                handshake: downstreamHandshake,
            }))
        checkAborted()

        try {
            await options.store.set(account, exchange.accessToken)
        } catch (error) {
            if (error instanceof CliError) throw error
            throw new CliError(
                'AUTH_STORE_WRITE_FAILED',
                `Failed to persist token: ${getErrorMessage(error)}`,
            )
        }

        return { token: exchange.accessToken, account }
    } finally {
        if (options.signal && abortListener) {
            options.signal.removeEventListener('abort', abortListener)
        }
        await server.stop()
    }
}

// ---------------------------------------------------------------------------
// Internal: local HTTP callback server. Not exported — OAuth login is the
// only consumer, so the surface lives inline rather than as a sibling module.
// ---------------------------------------------------------------------------

type CallbackResult = { code: string; state: string }

type CallbackServerHandle = {
    redirectUri: string
    waitForCallback(timeoutMs: number): Promise<CallbackResult>
    stop(): Promise<void>
}

type CallbackServerOptions = {
    preferredPort: number
    portFallbackCount: number
    path: string
    host: string
    expectedState: string
    renderSuccess: () => string
    renderError: (message: string) => string
}

async function startCallbackServer(options: CallbackServerOptions): Promise<CallbackServerHandle> {
    type Outcome = { ok: true; result: CallbackResult } | { ok: false; error: Error }
    let settle: ((outcome: Outcome) => void) | null = null
    const outcomePromise = new Promise<Outcome>((resolve) => {
        settle = resolve
    })

    const server = createServer((req, res) => {
        handleRequest(req, res, {
            path: options.path,
            expectedState: options.expectedState,
            renderSuccess: options.renderSuccess,
            renderError: options.renderError,
            settle: (outcome) => settle?.(outcome),
        })
    })

    const port = await listenWithFallback(
        server,
        options.host,
        options.preferredPort,
        options.portFallbackCount,
    )
    // Advertise as `localhost` when bound to the IPv4 loopback default —
    // matches the redirect-URI allowlists OAuth apps typically register.
    // IPv6 literals get bracket-wrapped per RFC 3986. Custom hostnames are
    // advertised verbatim.
    const redirectUri = `http://${formatHostForUrl(options.host)}:${port}${options.path}`

    let stopped = false
    return {
        redirectUri,
        async waitForCallback(timeoutMs) {
            let timer: NodeJS.Timeout | undefined
            const timeoutOutcome = new Promise<Outcome>((resolve) => {
                timer = setTimeout(() => {
                    resolve({
                        ok: false,
                        error: new CliError(
                            'AUTH_CALLBACK_TIMEOUT',
                            `Authorization timed out after ${Math.round(timeoutMs / 1000)}s.`,
                            {
                                hints: ['Re-run the login command and complete the browser step.'],
                            },
                        ),
                    })
                }, timeoutMs)
            })
            try {
                const outcome = await Promise.race([outcomePromise, timeoutOutcome])
                if (!outcome.ok) throw outcome.error
                return outcome.result
            } finally {
                if (timer) clearTimeout(timer)
            }
        },
        async stop() {
            if (stopped) return
            stopped = true
            // Settle the outcome so a still-pending `waitForCallback`
            // (e.g. one cancelled via AbortSignal) doesn't hang forever.
            settle?.({
                ok: false,
                error: new CliError(
                    'AUTH_OAUTH_FAILED',
                    'Callback server stopped before authorization completed.',
                ),
            })
            // Browsers keep the success-page connection alive for several
            // seconds after the redirect; closeAllConnections lets the CLI
            // exit promptly instead of waiting for those sockets.
            server.closeAllConnections()
            await new Promise<void>((resolve) => server.close(() => resolve()))
        },
    }
}

type RequestContext = {
    path: string
    expectedState: string
    renderSuccess: () => string
    renderError: (message: string) => string
    settle: (outcome: { ok: true; result: CallbackResult } | { ok: false; error: Error }) => void
}

function handleRequest(req: IncomingMessage, res: ServerResponse, ctx: RequestContext): void {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (url.pathname !== ctx.path) {
        res.statusCode = 404
        res.setHeader('Content-Type', 'text/plain; charset=utf-8')
        res.end('Not found')
        return
    }

    const error = url.searchParams.get('error')
    if (error) {
        const description = url.searchParams.get('error_description') ?? error
        respondHtml(res, 400, ctx.renderError(description))
        ctx.settle({
            ok: false,
            error: new CliError('AUTH_OAUTH_FAILED', `Authorization failed: ${description}`, {
                hints: ['Check the browser tab for details and try again.'],
            }),
        })
        return
    }

    // Bad-shape callbacks (missing code/state, state mismatch) render a 400
    // page but do *not* settle the wait — a browser-extension prefetch or
    // accidental reload shouldn't kill an in-flight OAuth flow. Only a
    // provider-driven `?error=` is treated as final. The wait still
    // settles on timeout / `stop()` if a valid callback never arrives.
    const code = url.searchParams.get('code')
    const state = url.searchParams.get('state')
    if (!code || !state) {
        respondHtml(res, 400, ctx.renderError('Authorization callback missing code or state.'))
        return
    }
    if (state !== ctx.expectedState) {
        respondHtml(
            res,
            400,
            ctx.renderError('Authorization state did not match. Possible CSRF attempt.'),
        )
        return
    }

    respondHtml(res, 200, ctx.renderSuccess())
    ctx.settle({ ok: true, result: { code, state } })
}

function respondHtml(res: ServerResponse, status: number, html: string): void {
    res.statusCode = status
    res.setHeader('Content-Type', 'text/html; charset=utf-8')
    res.setHeader('Cache-Control', 'no-store')
    res.end(html)
}

async function listenWithFallback(
    server: Server,
    host: string,
    preferred: number,
    fallback: number,
): Promise<number> {
    // Port 0 = OS-assigned ephemeral. The bind always succeeds and there's
    // nothing meaningful to walk to from there.
    if (preferred === 0) {
        try {
            await tryListen(server, host, 0)
        } catch (error) {
            throw wrapBindError(error, host, 0)
        }
        const address = server.address()
        if (!address || typeof address === 'string') {
            throw new CliError('AUTH_PORT_BIND_FAILED', 'Could not resolve assigned port.')
        }
        return address.port
    }

    let lastError: NodeJS.ErrnoException | null = null
    for (let i = 0; i <= fallback; i++) {
        const port = preferred + i
        // Stop walking past the valid port range; otherwise `server.listen`
        // throws a raw `RangeError` outside the `CliError` envelope.
        if (port > 65535) break
        try {
            await tryListen(server, host, port)
            return port
        } catch (error) {
            const err = error as NodeJS.ErrnoException
            // Surface non-EADDRINUSE failures (EACCES on privileged ports,
            // an unreachable host, …) via the typed error envelope rather
            // than letting Node's raw error escape.
            if (err.code !== 'EADDRINUSE') throw wrapBindError(err, host, port)
            lastError = err
        }
    }
    throw new CliError(
        'AUTH_PORT_BIND_FAILED',
        `Could not bind a local port in range ${preferred}..${preferred + fallback}.`,
        {
            hints: [
                'Free a port in that range or pass a different preferred port.',
                lastError?.message ?? '',
            ].filter(Boolean),
        },
    )
}

function wrapBindError(error: unknown, host: string, port: number): CliError {
    return new CliError(
        'AUTH_PORT_BIND_FAILED',
        `Could not bind callback server to ${host}:${port}: ${getErrorMessage(error)}`,
    )
}

function tryListen(server: Server, host: string, port: number): Promise<void> {
    return new Promise((resolve, reject) => {
        const onError = (err: Error) => {
            server.removeListener('listening', onListening)
            reject(err)
        }
        const onListening = () => {
            server.removeListener('error', onError)
            resolve()
        }
        server.once('error', onError)
        server.once('listening', onListening)
        server.listen(port, host)
    })
}

function formatHostForUrl(host: string): string {
    if (host === DEFAULT_CALLBACK_HOST) return 'localhost'
    if (host.includes(':')) return `[${host}]`
    return host
}

function assertValidPort(port: unknown, label: string): asserts port is number {
    if (typeof port !== 'number' || !Number.isInteger(port) || port < 0 || port > 65535) {
        throw new CliError(
            'AUTH_PORT_BIND_FAILED',
            `Invalid ${label} '${String(port)}': expected an integer in [0..65535].`,
        )
    }
}

async function openOrFallback(
    url: string,
    options: RunOAuthFlowOptions<AuthAccount>,
): Promise<void> {
    // Surface the URL up-front, before attempting the browser spawn. The
    // spawn can succeed yet open no browser (WSL without working interop,
    // headless Linux, locked-down corporate envs, missing `open` peer), and
    // we have no reliable signal that the user actually landed on the page
    // — so printing here guarantees a copy-pasteable path on every platform.
    if (options.onAuthorizeUrl) options.onAuthorizeUrl(url)
    else if (isStdoutTTY()) console.log(`Open this URL in your browser:\n  ${url}`)

    const opener = options.openBrowser ?? (await loadDefaultOpener())
    if (!opener) return
    try {
        await opener(url)
    } catch {
        // URL is already surfaced above.
    }
}

async function loadDefaultOpener(): Promise<((url: string) => Promise<void>) | null> {
    // WSL check must run before the headless check: WSL is `platform === 'linux'`
    // and often has no DISPLAY, but `cmd.exe` does work and reaches the user's
    // real Windows browser, so it's worth the spawn.
    if (isWsl()) return openViaCmdExe
    if (isHeadlessLinux()) return null
    try {
        const mod = (await import('open')) as { default: (url: string) => Promise<unknown> }
        return async (url) => {
            await mod.default(url)
        }
    } catch {
        return null
    }
}

// `start ""` — the empty title arg is mandatory; otherwise `start` consumes
// the URL as a window title and never launches a browser. The URL itself is
// wrapped in literal double quotes because `cmd.exe /c` is a shell: WSL
// interop reconstructs the command line and only auto-quotes args that
// contain spaces, so an OAuth URL (no spaces, plenty of `&`s) would
// otherwise be re-parsed by `cmd.exe` with `&` acting as a statement
// separator — only the prefix up to the first `&` reaches `start`. The
// embedded quotes keep the URL one token. (`execFile`'s no-shell guarantee
// doesn't apply when the target is itself a shell.)
async function openViaCmdExe(url: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        execFile('cmd.exe', ['/c', 'start', '""', `"${url}"`], { windowsHide: true }, (error) => {
            if (error) reject(error)
            else resolve()
        })
    })
}
