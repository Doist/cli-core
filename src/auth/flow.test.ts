import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { runOAuthFlow } from './flow.js'
import { createConfigTokenStore } from './store/config.js'
import type { AuthProvider } from './types.js'

type Account = { id: string; label?: string; email: string }

let dir: string
let path: string

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cli-core-flow-'))
    path = join(dir, 'config.json')
})

afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
})

function makeProvider(overrides: Partial<AuthProvider<Account>> = {}): AuthProvider<Account> {
    return {
        async authorize(input) {
            return {
                authorizeUrl: `https://example.com/oauth/authorize?state=${input.state}`,
                handshake: { codeVerifier: 'v1' },
            }
        },
        async exchangeCode() {
            return { accessToken: 'tok-1' }
        },
        async validateToken() {
            return { id: '1', email: 'a@b' }
        },
        ...overrides,
    }
}

const renderSuccess = () => '<html>ok</html>'
const renderError = () => '<html>err</html>'

describe('runOAuthFlow', () => {
    it('drives prepare → authorize → exchange → validate → store and returns the result', async () => {
        const prepare = vi.fn(async () => ({ handshake: { dcrSecret: 'shh' } }))
        const exchangeCode = vi.fn(async () => ({ accessToken: 'tok-1' }))
        const validateToken = vi.fn(async () => ({
            id: '1',
            email: 'a@b',
        }))

        const provider = makeProvider({ prepare, exchangeCode, validateToken })
        const store = createConfigTokenStore<Account>({ configPath: path, multiUser: false })

        // Drive a callback into the server as soon as the browser-open hook fires.
        const openBrowser = vi.fn(async (url: string) => {
            // Hit the callback synchronously after openBrowser returns.
            const u = new URL(url)
            const state = u.searchParams.get('state') ?? ''
            const callbackHost = url.replace(/https:\/\/example\.com\/oauth\/authorize\?.*$/, '')
            // The opener gets the *authorize* URL, not the redirect URI; we need
            // the redirect URI from the running server. Fish it out via the
            // referer-style assumption: the test server renders /callback on a
            // local port we don't know yet from inside this hook. Instead, use
            // the global fetch with a known port discovered after the fact.
            void state
            void callbackHost
        })

        // Trick: openBrowser cannot see the server URL. So instead, intercept
        // the print fallback by making `onAuthorizeUrl` perform the callback.
        const result = await new Promise<{ token: string; account: Account }>((resolve, reject) => {
            const onAuthorizeUrl = (authorizeUrl: string) => {
                void authorizeUrl
                // The redirect URI is exposed through the server, but flow.ts
                // doesn't surface it. Use a side channel: read the running
                // server's port from openBrowser's URL is hard. Instead,
                // make the provider emit a known authorize URL and hit the
                // local callback by enumerating common ports.
                // Simpler: we listen for the openBrowser invocation, use a
                // CountdownLatch via a global, and the test fakes the
                // entire callback by extracting the state from the URL
                // and POSTing to the server via `fetch` to a port we know
                // in advance.
                const u = new URL(authorizeUrl)
                const state = u.searchParams.get('state') ?? ''
                fetch(`http://localhost:${preferredPort}/callback?code=abc&state=${state}`)
            }
            const preferredPort = 39871
            runOAuthFlow<Account>({
                provider,
                store,
                displayName: 'Test',
                scopes: ['read'],
                readOnly: false,
                flags: {},
                preferredPort,
                renderSuccess,
                renderError,
                openBrowser,
                onAuthorizeUrl,
                timeoutMs: 5000,
            }).then(resolve, reject)
        })

        expect(result.token).toBe('tok-1')
        expect(result.account).toEqual({ id: '1', email: 'a@b' })
        expect(prepare).toHaveBeenCalledTimes(1)
        expect(exchangeCode).toHaveBeenCalledTimes(1)
        expect(validateToken).toHaveBeenCalledTimes(1)
        expect(openBrowser).toHaveBeenCalledTimes(1)

        // Token was persisted.
        const persisted = await store.active()
        expect(persisted).toEqual({ token: 'tok-1', account: { id: '1', email: 'a@b' } })
    })

    it('skips validateToken when exchangeCode returns an account', async () => {
        const validateToken = vi.fn(async () => ({ id: 'WRONG', email: 'x@x' }))
        const provider = makeProvider({
            exchangeCode: async () => ({
                accessToken: 'tok-1',
                account: { id: '99', email: 'right@b' },
            }),
            validateToken,
        })
        const store = createConfigTokenStore<Account>({ configPath: path, multiUser: false })

        const preferredPort = 39872
        const result = await new Promise<{ token: string; account: Account }>((resolve, reject) => {
            runOAuthFlow<Account>({
                provider,
                store,
                displayName: 'Test',
                scopes: [],
                readOnly: false,
                flags: {},
                preferredPort,
                renderSuccess,
                renderError,
                openBrowser: async () => {},
                onAuthorizeUrl: (url) => {
                    const state = new URL(url).searchParams.get('state') ?? ''
                    fetch(`http://localhost:${preferredPort}/callback?code=abc&state=${state}`)
                },
                timeoutMs: 5000,
            }).then(resolve, reject)
        })
        expect(result.account.id).toBe('99')
        expect(validateToken).not.toHaveBeenCalled()
    })

    it('rejects with AUTH_CALLBACK_TIMEOUT when no callback arrives', async () => {
        const provider = makeProvider()
        const store = createConfigTokenStore<Account>({ configPath: path, multiUser: false })
        await expect(
            runOAuthFlow<Account>({
                provider,
                store,
                displayName: 'Test',
                scopes: [],
                readOnly: false,
                flags: {},
                preferredPort: 39873,
                renderSuccess,
                renderError,
                openBrowser: async () => {}, // never triggers a callback
                timeoutMs: 50,
            }),
        ).rejects.toMatchObject({ code: 'AUTH_CALLBACK_TIMEOUT' })
    })
})
