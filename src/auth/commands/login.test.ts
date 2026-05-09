import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createConfigTokenStore } from '../store/config.js'
import type { AuthProvider } from '../types.js'
import { runLogin } from './login.js'

type Account = { id: string; label?: string; email: string }

let dir: string
let path: string
let logs: string[]
let originalLog: typeof console.log

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cli-core-login-'))
    path = join(dir, 'config.json')
    logs = []
    originalLog = console.log
    console.log = (...args: unknown[]) => {
        logs.push(args.map(String).join(' '))
    }
})

afterEach(async () => {
    console.log = originalLog
    await rm(dir, { recursive: true, force: true })
})

const renderSuccess = () => '<html>ok</html>'
const renderError = () => '<html>err</html>'

function makeProvider(account: Account = { id: '1', email: 'a@b' }): AuthProvider<Account> {
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
            return account
        },
    }
}

async function driveCallback(redirectUri: string, state: string): Promise<void> {
    await fetch(`${redirectUri}?code=abc&state=${state}`)
}

describe('runLogin', () => {
    it('drives the OAuth flow and persists the resulting token', async () => {
        const provider = makeProvider()
        const store = createConfigTokenStore<Account>({ configPath: path, multiUser: false })

        // Capture the redirectUri from inside the provider's authorize and
        // POST to it from the openBrowser hook.
        let redirectUri = ''
        const wrapped: AuthProvider<Account> = {
            ...provider,
            async authorize(input) {
                redirectUri = input.redirectUri
                return provider.authorize(input)
            },
        }
        const openBrowser = vi.fn(async (url: string) => {
            const state = new URL(url).searchParams.get('state') ?? ''
            await driveCallback(redirectUri, state)
        })

        await runLogin(
            {
                provider: wrapped,
                store,
                displayName: 'Test',
                resolveScopes: () => [],
                callbackPort: { preferred: 0 },
                renderSuccess,
                renderError,
                openBrowser,
            },
            {},
        )

        expect((await store.active())?.token).toBe('tok-1')
        expect(openBrowser).toHaveBeenCalledTimes(1)
    })

    it('threads loginFlags through to resolveScopes via the flags bag', async () => {
        const provider = makeProvider()
        const store = createConfigTokenStore<Account>({ configPath: path, multiUser: false })
        const resolveScopes = vi.fn(({ flags }) => {
            expect(flags.additionalScopes).toEqual(['app-management'])
            return ['data:read_write', 'app-management']
        })

        let redirectUri = ''
        const wrapped: AuthProvider<Account> = {
            ...provider,
            async authorize(input) {
                redirectUri = input.redirectUri
                expect(input.scopes).toEqual(['data:read_write', 'app-management'])
                return provider.authorize(input)
            },
        }

        await runLogin(
            {
                provider: wrapped,
                store,
                displayName: 'Test',
                resolveScopes,
                callbackPort: { preferred: 0 },
                renderSuccess,
                renderError,
                openBrowser: async (url) => {
                    const state = new URL(url).searchParams.get('state') ?? ''
                    await driveCallback(redirectUri, state)
                },
            },
            { additionalScopes: ['app-management'] },
        )
        expect(resolveScopes).toHaveBeenCalled()
    })
})
