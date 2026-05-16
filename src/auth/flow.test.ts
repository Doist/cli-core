import { afterEach, describe, expect, it, vi } from 'vitest'

// Partial-mock both modules so the default-opener branches (WSL → `cmd.exe`,
// headless Linux → no opener) can be exercised end-to-end through
// `runOAuthFlow`'s public surface. Tests that inject `openBrowser` never
// touch either mock, so the rest of the suite is unaffected.
vi.mock('node:fs', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:fs')>()
    return { ...actual, readFileSync: vi.fn(actual.readFileSync) }
})
vi.mock('node:child_process', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:child_process')>()
    return { ...actual, execFile: vi.fn(actual.execFile) }
})
// Mock the `open` peer-dep too, otherwise the `$BROWSER` test below falls
// through to the real `open` package, which captures `process.platform` at
// module-load (before our runtime stub) and on macOS spawns the real `open`
// command — launching live browser tabs from the test runner.
vi.mock('open', () => ({ default: vi.fn(async () => undefined) }))

import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import openBrowserModule from 'open'
import { type RunOAuthFlowOptions, runOAuthFlow } from './flow.js'
import type { AuthProvider, TokenStore } from './types.js'

type Account = { id: string; label?: string; email: string }

/** Tiny in-memory `TokenStore` so the flow tests don't need disk I/O. */
function fakeStore(): TokenStore<Account> & { last?: { account: Account; token: string } } {
    const state: { last?: { account: Account; token: string } } = {}
    return {
        async active() {
            return state.last ?? null
        },
        async set(account, token) {
            state.last = { account, token }
        },
        async clear() {
            state.last = undefined
        },
        async list() {
            return state.last ? [{ account: state.last.account, isDefault: true }] : []
        },
        async setDefault() {},
        get last() {
            return state.last
        },
    }
}

const renderSuccess = () => '<html>ok</html>'
const renderError = () => '<html>err</html>'

/**
 * Build a provider that records the runtime-assigned redirectUri so the
 * caller's `openBrowser` mock can drive the callback against the actual
 * server port (rather than guessing a hardcoded one).
 *
 * Caller-supplied `authorize` overrides are wrapped, not replaced, so the
 * redirectUri capture survives.
 */
function instrument(provider: Partial<AuthProvider<Account>> = {}): {
    provider: AuthProvider<Account>
    getRedirect: () => string
} {
    let redirectUri = ''
    const defaultAuthorize: AuthProvider<Account>['authorize'] = async (input) => ({
        authorizeUrl: `https://example.com/oauth/authorize?state=${input.state}`,
        handshake: { codeVerifier: 'v1' },
    })
    const innerAuthorize: AuthProvider<Account>['authorize'] =
        provider.authorize ?? defaultAuthorize
    const { authorize: _drop, ...rest } = provider
    void _drop
    const wrapped: AuthProvider<Account> = {
        async exchangeCode() {
            return { accessToken: 'tok-1' }
        },
        async validateToken() {
            return { id: '1', email: 'a@b' }
        },
        ...rest,
        async authorize(input) {
            redirectUri = input.redirectUri
            return innerAuthorize(input)
        },
    }
    return { provider: wrapped, getRedirect: () => redirectUri }
}

/**
 * Fill in the boilerplate fields every test would otherwise repeat
 * (`scopes`, `readOnly`, `flags`, `preferredPort`, `renderSuccess`,
 * `renderError`, `timeoutMs`). Caller supplies the variants — `provider`,
 * `store`, `openBrowser` are required; anything else overrides a default.
 */
function flowOptions(
    overrides: Partial<RunOAuthFlowOptions<Account>> &
        Pick<RunOAuthFlowOptions<Account>, 'provider' | 'store' | 'openBrowser'>,
): RunOAuthFlowOptions<Account> {
    return {
        scopes: [],
        readOnly: false,
        flags: {},
        preferredPort: 0,
        renderSuccess,
        renderError,
        timeoutMs: 5000,
        ...overrides,
    }
}

/**
 * Drive the local callback server with a valid `code` + the `state` lifted
 * from the authorize URL. Used as both an `openBrowser` and an
 * `onAuthorizeUrl` stand-in across the suite.
 */
function driveCallback(getRedirect: () => string): (url: string) => Promise<void> {
    return async (url) => {
        const state = new URL(url).searchParams.get('state') ?? ''
        await fetch(`${getRedirect()}?code=abc&state=${state}`)
    }
}

describe('runOAuthFlow', () => {
    it('drives prepare → authorize → exchange → validate → store and returns the result', async () => {
        const prepare = vi.fn(async () => ({ handshake: { dcrSecret: 'shh' } }))
        const exchangeCode = vi.fn(async () => ({ accessToken: 'tok-1' }))
        const validateToken = vi.fn(async () => ({ id: '1', email: 'a@b' }))
        const { provider, getRedirect } = instrument({ prepare, exchangeCode, validateToken })
        const store = fakeStore()
        const openBrowser = vi.fn(driveCallback(getRedirect))

        const result = await runOAuthFlow<Account>(
            flowOptions({
                provider,
                store,
                scopes: ['read'],
                openBrowser,
                onAuthorizeUrl: () => undefined,
            }),
        )

        expect(result.token).toBe('tok-1')
        expect(result.account).toEqual({ id: '1', email: 'a@b' })
        expect(prepare).toHaveBeenCalledTimes(1)
        expect(exchangeCode).toHaveBeenCalledTimes(1)
        expect(validateToken).toHaveBeenCalledTimes(1)
        expect(openBrowser).toHaveBeenCalledTimes(1)
        expect(await store.active()).toEqual({
            token: 'tok-1',
            account: { id: '1', email: 'a@b' },
        })
    })

    it('skips validateToken when exchangeCode returns an account', async () => {
        const validateToken = vi.fn(async () => ({ id: 'WRONG', email: 'x@x' }))
        const { provider, getRedirect } = instrument({
            exchangeCode: async () => ({
                accessToken: 'tok-1',
                account: { id: '99', email: 'right@b' },
            }),
            validateToken,
        })
        const store = fakeStore()

        const result = await runOAuthFlow<Account>(
            flowOptions({ provider, store, openBrowser: driveCallback(getRedirect) }),
        )
        expect(result.account.id).toBe('99')
        expect(validateToken).not.toHaveBeenCalled()
    })

    it('threads prepare-time handshake into validateToken even when authorize forgets to forward it', async () => {
        const validateToken = vi.fn(async ({ handshake }) => {
            expect(handshake.dcrSecret).toBe('shh') // came from prepare(), not authorize()
            return { id: '1', email: 'a@b' }
        })
        const { provider, getRedirect } = instrument({
            prepare: async () => ({ handshake: { dcrSecret: 'shh' } }),
            // authorize deliberately drops the prepare handshake — runOAuthFlow
            // must merge it back in for downstream methods.
            authorize: async (input) => ({
                authorizeUrl: `https://example.com/oauth/authorize?state=${input.state}`,
                handshake: { codeVerifier: 'v1' },
            }),
            validateToken,
        })
        const store = fakeStore()

        await runOAuthFlow<Account>(
            flowOptions({ provider, store, openBrowser: driveCallback(getRedirect) }),
        )
        expect(validateToken).toHaveBeenCalledTimes(1)
    })

    it('rejects with AUTH_CALLBACK_TIMEOUT when no callback arrives', async () => {
        const { provider } = instrument()
        const store = fakeStore()
        await expect(
            runOAuthFlow<Account>(
                flowOptions({
                    provider,
                    store,
                    openBrowser: async () => {}, // never triggers a callback
                    timeoutMs: 50,
                }),
            ),
        ).rejects.toMatchObject({ code: 'AUTH_CALLBACK_TIMEOUT' })
    })

    it('keeps the callback server listening on bad-shape requests; resolves on the eventual valid one', async () => {
        const { provider, getRedirect } = instrument()
        const store = fakeStore()

        const result = await runOAuthFlow<Account>(
            flowOptions({
                provider,
                store,
                openBrowser: async (url) => {
                    const state = new URL(url).searchParams.get('state') ?? ''
                    // Spurious requests (browser-extension prefetch, accidental
                    // reload) that don't match the expected state should leave the
                    // server listening rather than killing the in-flight flow.
                    const bad1 = await fetch(`${getRedirect()}?code=abc&state=wrong`)
                    expect(bad1.status).toBe(400)
                    const bad2 = await fetch(`${getRedirect()}?code=abc`)
                    expect(bad2.status).toBe(400)
                    // The legitimate redirect arriving after the noise should still
                    // settle the wait.
                    await fetch(`${getRedirect()}?code=abc&state=${state}`)
                },
            }),
        )
        expect(result.token).toBe('tok-1')
    })

    it('rejects an invalid preferredPort with AUTH_PORT_BIND_FAILED before opening the browser', async () => {
        const openBrowser = vi.fn(async () => undefined)
        const { provider } = instrument()
        const store = fakeStore()
        await expect(
            runOAuthFlow<Account>(
                flowOptions({ provider, store, openBrowser, preferredPort: 70_000 }),
            ),
        ).rejects.toMatchObject({ code: 'AUTH_PORT_BIND_FAILED' })
        expect(openBrowser).not.toHaveBeenCalled()
    })

    it('halts via AbortSignal: aborting before the callback rejects with AUTH_OAUTH_FAILED and skips store.set', async () => {
        const controller = new AbortController()
        const { provider, getRedirect } = instrument()
        const store = fakeStore()
        const setSpy = vi.spyOn(store, 'set')

        await expect(
            runOAuthFlow<Account>(
                flowOptions({
                    provider,
                    store,
                    openBrowser: async () => {
                        // Abort before the callback arrives — flow should reject
                        // with AUTH_OAUTH_FAILED rather than continue waiting.
                        controller.abort()
                        void getRedirect() // touch to silence unused-fn lint
                    },
                    onAuthorizeUrl: () => undefined,
                    signal: controller.signal,
                }),
            ),
        ).rejects.toMatchObject({ code: 'AUTH_OAUTH_FAILED' })
        expect(setSpy).not.toHaveBeenCalled()
    })

    it('always surfaces the authorize URL via onAuthorizeUrl, even when openBrowser succeeds', async () => {
        // The browser spawn can resolve cleanly yet open no actual browser
        // (WSL no-op, headless Linux, etc.), so the URL must reach the user
        // on every successful run — not only on opener failure.
        const { provider, getRedirect } = instrument()
        const store = fakeStore()
        const onAuthorizeUrl = vi.fn((_url: string) => undefined)
        const openBrowser = vi.fn(driveCallback(getRedirect))
        const result = await runOAuthFlow<Account>(
            flowOptions({ provider, store, openBrowser, onAuthorizeUrl }),
        )
        expect(onAuthorizeUrl).toHaveBeenCalledTimes(1)
        expect(onAuthorizeUrl.mock.calls[0][0]).toMatch(/^https:\/\/example\.com\/oauth\/authorize/)
        expect(openBrowser).toHaveBeenCalledTimes(1)
        expect(result.token).toBe('tok-1')
    })

    it('falls back to onAuthorizeUrl when the openBrowser opener throws', async () => {
        const { provider, getRedirect } = instrument()
        const store = fakeStore()
        const onAuthorizeUrl = vi.fn(driveCallback(getRedirect))
        const result = await runOAuthFlow<Account>(
            flowOptions({
                provider,
                store,
                openBrowser: async () => {
                    throw new Error('opener boom')
                },
                onAuthorizeUrl,
            }),
        )
        expect(onAuthorizeUrl).toHaveBeenCalledTimes(1)
        expect(onAuthorizeUrl.mock.calls[0][0]).toMatch(/^https:\/\/example\.com\/oauth\/authorize/)
        expect(result.token).toBe('tok-1')
    })

    it('wraps non-CliError store.set failures in AUTH_STORE_WRITE_FAILED', async () => {
        const { provider, getRedirect } = instrument()
        const store: TokenStore<Account> = {
            async active() {
                return null
            },
            async set() {
                throw new Error('disk full')
            },
            async clear() {},
            async list() {
                return []
            },
            async setDefault() {},
        }
        await expect(
            runOAuthFlow<Account>(
                flowOptions({
                    provider,
                    store,
                    openBrowser: driveCallback(getRedirect),
                    onAuthorizeUrl: () => undefined,
                }),
            ),
        ).rejects.toMatchObject({ code: 'AUTH_STORE_WRITE_FAILED' })
    })
})

describe('runOAuthFlow default opener selection', () => {
    const originalPlatform = process.platform

    afterEach(() => {
        Object.defineProperty(process, 'platform', {
            value: originalPlatform,
            configurable: true,
        })
        vi.unstubAllEnvs()
        vi.mocked(readFileSync).mockReset()
        vi.mocked(execFile).mockReset()
        vi.mocked(openBrowserModule).mockReset()
    })

    function stubPlatform(value: NodeJS.Platform): void {
        Object.defineProperty(process, 'platform', { value, configurable: true })
    }

    it('routes WSL via cmd.exe with the URL wrapped in literal quotes', async () => {
        // Quoting the URL is load-bearing: `cmd.exe /c` re-parses the
        // command line, and WSL interop only auto-quotes args containing
        // spaces. An unquoted OAuth URL would let `&` split the line into
        // separate commands and `start` would only see the prefix.
        stubPlatform('linux')
        vi.mocked(readFileSync).mockReturnValue('Linux 5.15 #1 SMP microsoft-WSL2')
        const execFileMock = vi.mocked(execFile)
        // The opener wraps execFile in a Promise that resolves on the
        // callback; invoke it synchronously with `null` to mimic a clean
        // spawn. The 4th arg's exact shape doesn't matter to us.
        execFileMock.mockImplementation(((
            _cmd: string,
            _args: readonly string[],
            _opts: unknown,
            cb: unknown,
        ) => {
            ;(cb as (err: Error | null) => void)(null)
            return {} as never
        }) as never)

        const { provider, getRedirect } = instrument()
        const store = fakeStore()
        const onAuthorizeUrl = vi.fn(driveCallback(getRedirect))

        await runOAuthFlow<Account>(flowOptions({ provider, store, onAuthorizeUrl }))

        expect(execFileMock).toHaveBeenCalledTimes(1)
        const [cmd, args] = execFileMock.mock.calls[0]
        const url = onAuthorizeUrl.mock.calls[0][0] as string
        expect(cmd).toBe('cmd.exe')
        expect(args).toEqual(['/c', 'start', '""', `"${url}"`])
    })

    it('skips the default opener entirely on headless Linux', async () => {
        // No DISPLAY / WAYLAND_DISPLAY / BROWSER + non-WSL Linux → there's
        // no working browser launch path. Don't pay the spawn cost; the URL
        // print is the only surface.
        stubPlatform('linux')
        vi.mocked(readFileSync).mockImplementation(() => {
            throw new Error('no /proc/version in this test env')
        })
        vi.stubEnv('DISPLAY', '')
        vi.stubEnv('WAYLAND_DISPLAY', '')
        vi.stubEnv('BROWSER', '')

        const { provider, getRedirect } = instrument()
        const store = fakeStore()
        const onAuthorizeUrl = vi.fn(driveCallback(getRedirect))

        const result = await runOAuthFlow<Account>(flowOptions({ provider, store, onAuthorizeUrl }))

        expect(result.token).toBe('tok-1')
        expect(execFile).not.toHaveBeenCalled()
    })

    it('honours $BROWSER on Linux: routes through the `open` peer-dep, not cmd.exe', async () => {
        // $BROWSER is the explicit user override Codespaces / custom
        // remote-bridge setups use to point `open` at their own helper.
        // When set, the headless short-circuit must not fire — let `open`
        // handle it. The `open` package is mocked at module scope so the
        // real binary never spawns (which would launch live browser tabs
        // on macOS dev machines, since `open` captures `process.platform`
        // at import time and ignores our runtime stub).
        stubPlatform('linux')
        vi.mocked(readFileSync).mockImplementation(() => {
            throw new Error('not wsl')
        })
        vi.stubEnv('DISPLAY', '')
        vi.stubEnv('WAYLAND_DISPLAY', '')
        vi.stubEnv('BROWSER', '/usr/local/bin/my-browser')

        const { provider, getRedirect } = instrument()
        const store = fakeStore()
        const onAuthorizeUrl = vi.fn(driveCallback(getRedirect))

        const result = await runOAuthFlow<Account>(flowOptions({ provider, store, onAuthorizeUrl }))

        expect(result.token).toBe('tok-1')
        expect(execFile).not.toHaveBeenCalled()
        expect(openBrowserModule).toHaveBeenCalledTimes(1)
        expect(openBrowserModule).toHaveBeenCalledWith(onAuthorizeUrl.mock.calls[0][0])
    })
})
