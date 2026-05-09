import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createConfigTokenStore } from '../store/config.js'
import type { AuthProvider } from '../types.js'
import { runLogin } from './login.js'

// Smoke-level only — flag-routing and integration via Commander live in
// register.test.ts. This file exists per AGENTS.md's strict colocation rule.

type Account = { id: string; label?: string; email: string }

let dir: string
let path: string

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cli-core-login-'))
    path = join(dir, 'config.json')
})

afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
})

describe('runLogin', () => {
    it('drives the OAuth flow and persists the resulting token', async () => {
        let redirectUri = ''
        const provider: AuthProvider<Account> = {
            async authorize(input) {
                redirectUri = input.redirectUri
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
        }
        const store = createConfigTokenStore<Account>({ configPath: path, multiUser: false })

        await runLogin(
            {
                provider,
                store,
                displayName: 'Test',
                resolveScopes: () => [],
                callbackPort: { preferred: 0 },
                renderSuccess: () => '',
                renderError: () => '',
                openBrowser: vi.fn(async (url: string) => {
                    const state = new URL(url).searchParams.get('state') ?? ''
                    await fetch(`${redirectUri}?code=abc&state=${state}`)
                }),
            },
            {},
        )

        expect((await store.active())?.token).toBe('tok-1')
    })
})
