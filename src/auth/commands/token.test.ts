import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createConfigTokenStore } from '../store/config.js'
import type { AuthProvider } from '../types.js'
import { runTokenSet, runTokenView } from './token.js'

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

async function readJson(): Promise<Record<string, unknown>> {
    return JSON.parse(await readFile(path, 'utf-8')) as Record<string, unknown>
}

describe('runTokenView', () => {
    it('prefers env token when set and no --user', async () => {
        process.env.TEST_API_TOKEN = 'env-tok'
        const store = createConfigTokenStore<Account>({ configPath: path, multiUser: false })
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
    })

    it('reads from store when no env override', async () => {
        const store = createConfigTokenStore<Account>({ configPath: path, multiUser: false })
        await store.set({ id: '1', email: 'a@b' }, 'tok-1')
        await runTokenView(
            {
                provider: pasteOnlyProvider(),
                store,
                displayName: 'Test',
                envTokenVar: 'TEST_API_TOKEN',
            },
            {},
        )
        expect(logs[0]).toBe('tok-1')
    })

    it('throws AUTH_NOT_LOGGED_IN when no token and no env', async () => {
        const store = createConfigTokenStore<Account>({ configPath: path, multiUser: false })
        await expect(
            runTokenView(
                {
                    provider: pasteOnlyProvider(),
                    store,
                    displayName: 'Test',
                    envTokenVar: 'TEST_API_TOKEN',
                },
                {},
            ),
        ).rejects.toMatchObject({ code: 'AUTH_NOT_LOGGED_IN' })
    })
})

describe('runTokenSet', () => {
    it('reads piped token, validates via provider, persists as active in one mutation', async () => {
        const store = createConfigTokenStore<Account>({ configPath: path, multiUser: true })
        const provider = pasteOnlyProvider()
        await runTokenSet(
            { provider, store, displayName: 'Test', envTokenVar: 'TEST_API_TOKEN' },
            {},
            { readToken: async () => 'paste-me' },
        )
        const active = await store.active()
        expect(active?.token).toBe('paste-me')
        // Single store mutation: accounts + tokens + auth_active_id all set in
        // one updateConfig call (no two-phase set + setActive cycle).
        const raw = await readJson()
        expect(raw.auth_active_id).toBe('1')
    })

    it('trims whitespace and rejects empty input', async () => {
        const store = createConfigTokenStore<Account>({ configPath: path, multiUser: false })
        const provider = pasteOnlyProvider()
        await expect(
            runTokenSet(
                { provider, store, displayName: 'Test', envTokenVar: 'TEST_API_TOKEN' },
                {},
                { readToken: async () => '   \n' },
            ),
        ).rejects.toMatchObject({ code: 'AUTH_INVALID_TOKEN' })
    })

    it('throws AUTH_PROVIDER_UNSUPPORTED when provider has no acceptPastedToken', async () => {
        const store = createConfigTokenStore<Account>({ configPath: path, multiUser: false })
        const provider: AuthProvider<Account> = {
            async authorize() {
                throw new Error()
            },
            async exchangeCode() {
                throw new Error()
            },
            async validateToken() {
                return { id: '1', email: 'a@b' }
            },
        }
        await expect(
            runTokenSet(
                { provider, store, displayName: 'Test', envTokenVar: 'TEST_API_TOKEN' },
                {},
                { readToken: async () => 'tok' },
            ),
        ).rejects.toMatchObject({ code: 'AUTH_PROVIDER_UNSUPPORTED' })
    })
})
