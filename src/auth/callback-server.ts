import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http'
import { CliError } from '../errors.js'
import type { ErrorContext, SuccessContext } from './types.js'

export type StartCallbackServerOptions = {
    /** Preferred local port. Server tries this first, then walks up. */
    preferredPort: number
    /** How many sequential ports to try if `preferredPort` is busy. Default 5. */
    portFallbackCount?: number
    /** Path the OAuth provider will redirect to. Default `'/callback'`. */
    path?: string
    /** State the callback's `state` query param must match. */
    expectedState: string
    /** HTML returned to the browser on success. */
    renderSuccess: (ctx: SuccessContext) => string
    /** HTML returned to the browser on failure. */
    renderError: (ctx: ErrorContext) => string
    /** Display name passed into renderSuccess/renderError contexts. */
    displayName: string
    /** Bind address. Default `'127.0.0.1'`. */
    host?: string
}

export type CallbackResult = {
    code: string
    state: string
}

export type CallbackServerHandle = {
    /** Bound port (the preferred one or the next free fallback). */
    port: number
    /** Loopback URL the OAuth provider should redirect to. */
    redirectUri: string
    /** Resolves with the validated callback. Rejects on timeout/state mismatch/provider error. */
    waitForCallback(timeoutMs?: number): Promise<CallbackResult>
    /** Stop the server. Idempotent. */
    stop(): Promise<void>
}

/**
 * Start a one-shot loopback HTTP server for an OAuth redirect. Handles port
 * fallback (if `preferredPort` is in use, tries the next `portFallbackCount`
 * ports), validates the `state` query param against `expectedState`, surfaces
 * provider-side OAuth errors as `CliError('AUTH_OAUTH_FAILED')`, and renders
 * the consumer-supplied success/error HTML.
 *
 * The server stays up until `stop()` is called — `waitForCallback` resolves on
 * the first valid callback but does not tear down the listener (the success
 * page may be loading assets, the close-countdown is still running, …). Call
 * `handle.stop()` from a `finally` once you're done.
 */
export async function startCallbackServer(
    options: StartCallbackServerOptions,
): Promise<CallbackServerHandle> {
    const path = options.path ?? '/callback'
    const host = options.host ?? '127.0.0.1'
    const fallback = options.portFallbackCount ?? 5

    type CallbackOutcome = { ok: true; result: CallbackResult } | { ok: false; error: Error }

    let settle: ((outcome: CallbackOutcome) => void) | null = null
    const outcomePromise = new Promise<CallbackOutcome>((resolve) => {
        settle = resolve
    })
    const resolveCallback = (result: CallbackResult): void => {
        settle?.({ ok: true, result })
    }
    const rejectCallback = (error: Error): void => {
        settle?.({ ok: false, error })
    }

    const server = createServer((req, res) => {
        handleRequest(req, res, {
            path,
            expectedState: options.expectedState,
            displayName: options.displayName,
            renderSuccess: options.renderSuccess,
            renderError: options.renderError,
            resolve: resolveCallback,
            reject: rejectCallback,
        })
    })

    const port = await listenWithFallback(server, host, options.preferredPort, fallback)
    // Use the literal bind host in the redirect URI rather than `localhost` so
    // the OAuth provider's redirect lands on the same address family the
    // server is listening on (avoids IPv6 ::1 vs IPv4 127.0.0.1 mismatches
    // when `localhost` resolves to both).
    const redirectUri = `http://${host}:${port}${path}`

    let stopped = false
    return {
        port,
        redirectUri,
        async waitForCallback(timeoutMs = 3 * 60 * 1000) {
            let timer: NodeJS.Timeout | undefined
            const timeoutOutcome = new Promise<CallbackOutcome>((resolve) => {
                timer = setTimeout(() => {
                    resolve({
                        ok: false,
                        error: new CliError(
                            'AUTH_CALLBACK_TIMEOUT',
                            `Authorization timed out after ${Math.round(timeoutMs / 1000)}s.`,
                            { hints: ['Re-run the login command and complete the browser step.'] },
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
            await new Promise<void>((resolve) => {
                server.close(() => resolve())
            })
        },
    }
}

type RequestContext = {
    path: string
    expectedState: string
    displayName: string
    renderSuccess: (ctx: SuccessContext) => string
    renderError: (ctx: ErrorContext) => string
    resolve: (result: CallbackResult) => void
    reject: (error: Error) => void
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
        const html = ctx.renderError({
            displayName: ctx.displayName,
            errorCode: error,
            message: description,
        })
        respondHtml(res, 400, html)
        ctx.reject(
            new CliError('AUTH_OAUTH_FAILED', `Authorization failed: ${description}`, {
                hints: ['Check the browser tab for details and try again.'],
            }),
        )
        return
    }

    const code = url.searchParams.get('code')
    const state = url.searchParams.get('state')
    if (!code || !state) {
        const html = ctx.renderError({
            displayName: ctx.displayName,
            message: 'Authorization callback missing code or state.',
        })
        respondHtml(res, 400, html)
        ctx.reject(
            new CliError('AUTH_OAUTH_FAILED', 'Authorization callback missing code or state.'),
        )
        return
    }

    if (state !== ctx.expectedState) {
        const html = ctx.renderError({
            displayName: ctx.displayName,
            message: 'Authorization state did not match. Possible CSRF attempt.',
        })
        respondHtml(res, 400, html)
        ctx.reject(
            new CliError('AUTH_STATE_MISMATCH', 'OAuth state mismatch — possible CSRF attempt.'),
        )
        return
    }

    const html = ctx.renderSuccess({ displayName: ctx.displayName })
    respondHtml(res, 200, html)
    ctx.resolve({ code, state })
}

function respondHtml(res: ServerResponse, statusCode: number, html: string): void {
    res.statusCode = statusCode
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
    // Port 0 is "let the OS pick a free ephemeral port" — the bind always
    // succeeds, and there's nothing meaningful to walk to from there.
    if (preferred === 0) {
        await tryListen(server, host, 0)
        const address = server.address()
        if (!address || typeof address === 'string') {
            throw new CliError('AUTH_PORT_BIND_FAILED', 'Could not resolve assigned port.')
        }
        return address.port
    }

    const total = fallback + 1
    let lastError: NodeJS.ErrnoException | null = null
    for (let i = 0; i < total; i++) {
        const port = preferred + i
        try {
            await tryListen(server, host, port)
            return port
        } catch (error) {
            const err = error as NodeJS.ErrnoException
            if (err.code !== 'EADDRINUSE') throw err
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
