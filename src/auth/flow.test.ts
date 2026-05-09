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

describe('runOAuthFlow', () => {
    it('drives prepare → authorize → exchange → validate → store and returns the result', async () => {
        const prepare = vi.fn(async () => ({ handshake: { dcrSecret: 'shh' } }))
        const exchangeCode = vi.fn(async () => ({ accessToken: 'tok-1' }))
        const validateToken = vi.fn(async () => ({ id: '1', email: 'a@b' }))
        const { provider, getRedirect } = instrument({ prepare, exchangeCode, validateToken })
        const store = createConfigTokenStore<Account>({ configPath: path, multiUser: false })

        const openBrowser = vi.fn(async (url: string) => {
            const state = new URL(url).searchParams.get('state') ?? ''
            await fetch(`${getRedirect()}?code=abc&state=${state}`)
        })

        const result = await runOAuthFlow<Account>({
            provider,
            store,
            displayName: 'Test',
            scopes: ['read'],
            readOnly: false,
            flags: {},
            preferredPort: 0,
            renderSuccess,
            renderError,
            openBrowser,
            timeoutMs: 5000,
        })

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
        const store = createConfigTokenStore<Account>({ configPath: path, multiUser: false })

        const result = await runOAuthFlow<Account>({
            provider,
            store,
            displayName: 'Test',
            scopes: [],
            readOnly: false,
            flags: {},
            preferredPort: 0,
            renderSuccess,
            renderError,
            openBrowser: async (url) => {
                const state = new URL(url).searchParams.get('state') ?? ''
                await fetch(`${getRedirect()}?code=abc&state=${state}`)
            },
            timeoutMs: 5000,
        })
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
        const store = createConfigTokenStore<Account>({ configPath: path, multiUser: false })

        await runOAuthFlow<Account>({
            provider,
            store,
            displayName: 'Test',
            scopes: [],
            readOnly: false,
            flags: {},
            preferredPort: 0,
            renderSuccess,
            renderError,
            openBrowser: async (url) => {
                const state = new URL(url).searchParams.get('state') ?? ''
                await fetch(`${getRedirect()}?code=abc&state=${state}`)
            },
            timeoutMs: 5000,
        })
        expect(validateToken).toHaveBeenCalledTimes(1)
    })

    it('rejects with AUTH_CALLBACK_TIMEOUT when no callback arrives', async () => {
        const { provider } = instrument()
        const store = createConfigTokenStore<Account>({ configPath: path, multiUser: false })
        await expect(
            runOAuthFlow<Account>({
                provider,
                store,
                displayName: 'Test',
                scopes: [],
                readOnly: false,
                flags: {},
                preferredPort: 0,
                renderSuccess,
                renderError,
                openBrowser: async () => {}, // never triggers a callback
                timeoutMs: 50,
            }),
        ).rejects.toMatchObject({ code: 'AUTH_CALLBACK_TIMEOUT' })
    })
})
