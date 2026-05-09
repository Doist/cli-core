import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createConfigTokenStore } from '../store/config.js'
import type { AuthProvider } from '../types.js'
import { runTokenSet, runTokenView } from './token.js'

// Smoke-level: env-vs-store precedence + the single-mutation set path.
// Stdin reading + TTY rejection live in register.test.ts.

type Account = { id: string; label?: string; email: string }

let dir: string
let path: string
let logs: string[]
let originalLog: typeof console.log

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cli-core-token-'))
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
    delete process.env.TEST_API_TOKEN
})

function pasteOnlyProvider(account: Account = { id: '1', email: 'a@b' }): AuthProvider<Account> {
    return {
        async authorize() {
            throw new Error('not used')
        },
        async exchangeCode() {
            throw new Error('not used')
        },
        async validateToken() {
            return account
        },
        async acceptPastedToken({ token }) {
            return { ...account, label: account.label ?? token.slice(0, 4) }
        },
    }
}

describe('runTokenView', () => {
    it('prefers env token when set and no --user; falls back to store otherwise', async () => {
        const store = createConfigTokenStore<Account>({ configPath: path, multiUser: false })
        await store.set({ id: '1', email: 'a@b' }, 'tok-store')

        process.env.TEST_API_TOKEN = 'env-tok'
        await runTokenView(
            {
                provider: pasteOnlyProvider(),
                store,
                displayName: 'Test',
                envTokenVar: 'TEST_API_TOKEN',
            },
            {},
        )
        expect(logs[0]).toBe('env-tok')

        delete process.env.TEST_API_TOKEN
        logs.length = 0
        await runTokenView(
            {
                provider: pasteOnlyProvider(),
                store,
                displayName: 'Test',
                envTokenVar: 'TEST_API_TOKEN',
            },
            {},
        )
        expect(logs[0]).toBe('tok-store')
    })
})

describe('runTokenSet', () => {
    it('reads piped token, validates via provider, persists as active in one mutation', async () => {
        const store = createConfigTokenStore<Account>({ configPath: path, multiUser: true })
        await runTokenSet(
            {
                provider: pasteOnlyProvider(),
                store,
                displayName: 'Test',
                envTokenVar: 'TEST_API_TOKEN',
            },
            {},
            { readToken: async () => 'paste-me' },
        )
        const active = await store.active()
        expect(active?.token).toBe('paste-me')
    })

    it('rejects empty/whitespace input with AUTH_INVALID_TOKEN', async () => {
        const store = createConfigTokenStore<Account>({ configPath: path, multiUser: false })
        await expect(
            runTokenSet(
                {
                    provider: pasteOnlyProvider(),
                    store,
                    displayName: 'Test',
                    envTokenVar: 'TEST_API_TOKEN',
                },
                {},
                { readToken: async () => '   \n' },
            ),
        ).rejects.toMatchObject({ code: 'AUTH_INVALID_TOKEN' })
    })
})
