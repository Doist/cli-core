import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createConfigTokenStore } from '../store/config.js'
import type { AuthProvider } from '../types.js'
import { runLogin } from './login.js'
import { runLogout } from './logout.js'
import { runStatus } from './status.js'
import { runTokenSet, runTokenView } from './token.js'

type Account = { id: string; label?: string; email: string }

let dir: string
let path: string
let logs: string[]
let originalLog: typeof console.log

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cli-core-handlers-'))
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

describe('runLogin --token', () => {
    it('routes through acceptPastedToken and persists', async () => {
        const store = createConfigTokenStore<Account>({ configPath: path, multiUser: false })
        const provider = pasteOnlyProvider()
        await runLogin(
            {
                provider,
                store,
                displayName: 'Test',
                resolveScopes: () => [],
                callbackPort: { preferred: 0 },
                renderSuccess: () => '',
                renderError: () => '',
            },
            { token: 'paste-me' },
        )
        const active = await store.active()
        expect(active?.token).toBe('paste-me')
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
            runLogin(
                {
                    provider,
                    store,
                    displayName: 'Test',
                    resolveScopes: () => [],
                    callbackPort: { preferred: 0 },
                    renderSuccess: () => '',
                    renderError: () => '',
                },
                { token: 'x' },
            ),
        ).rejects.toMatchObject({ code: 'AUTH_PROVIDER_UNSUPPORTED' })
    })
})

describe('runStatus', () => {
    it('reports env override when env var is set', async () => {
        process.env.TEST_API_TOKEN = 'env-tok'
        const store = createConfigTokenStore<Account>({ configPath: path, multiUser: false })
        await runStatus(
            { store, displayName: 'Test', envTokenVar: 'TEST_API_TOKEN' },
            { json: true },
        )
        const out = JSON.parse(logs[0]) as { backend: string; envTokenSet: boolean }
        expect(out.backend).toBe('env')
        expect(out.envTokenSet).toBe(true)
    })

    it('reports not-signed-in human output when nothing is stored', async () => {
        const store = createConfigTokenStore<Account>({ configPath: path, multiUser: false })
        await runStatus({ store, displayName: 'Test', envTokenVar: 'TEST_API_TOKEN' }, {})
        expect(logs[0]).toContain('Not signed in')
    })

    it('lists multiple accounts in multi-user mode', async () => {
        const store = createConfigTokenStore<Account>({ configPath: path, multiUser: true })
        await store.set({ id: '1', label: 'Alice', email: 'a@b' }, 'tok-1')
        await store.set({ id: '2', label: 'Bob', email: 'b@b' }, 'tok-2')
        await runStatus(
            { store, displayName: 'Test', envTokenVar: 'TEST_API_TOKEN' },
            { json: true },
        )
        const out = JSON.parse(logs[0]) as {
            accounts: Account[]
            activeAccount: Account
        }
        expect(out.accounts).toHaveLength(2)
        expect(out.activeAccount.id).toBe('1')
    })
})

describe('runLogout', () => {
    it('removes the active account by default', async () => {
        const store = createConfigTokenStore<Account>({ configPath: path, multiUser: true })
        await store.set({ id: '1', email: 'a@b' }, 'tok-1')
        await store.set({ id: '2', email: 'b@b' }, 'tok-2')
        await runLogout({ store, displayName: 'Test' }, {})
        const remaining = await store.list()
        expect(remaining.map((a) => a.id)).toEqual(['2'])
    })

    it('--all clears every credential', async () => {
        const store = createConfigTokenStore<Account>({ configPath: path, multiUser: true })
        await store.set({ id: '1', email: 'a@b' }, 'tok-1')
        await store.set({ id: '2', email: 'b@b' }, 'tok-2')
        await runLogout({ store, displayName: 'Test' }, { all: true })
        expect(await store.list()).toEqual([])
    })

    it('--user removes a specific account', async () => {
        const store = createConfigTokenStore<Account>({ configPath: path, multiUser: true })
        await store.set({ id: '1', email: 'a@b' }, 'tok-1')
        await store.set({ id: '2', email: 'b@b' }, 'tok-2')
        await runLogout({ store, displayName: 'Test' }, { user: '2' })
        expect((await store.list()).map((a) => a.id)).toEqual(['1'])
    })

    it('throws AUTH_NOT_LOGGED_IN when nothing to remove and no flags', async () => {
        const store = createConfigTokenStore<Account>({ configPath: path, multiUser: true })
        await expect(runLogout({ store, displayName: 'Test' }, {})).rejects.toMatchObject({
            code: 'AUTH_NOT_LOGGED_IN',
        })
    })

    it('throws AUTH_USER_NOT_FOUND for unknown --user', async () => {
        const store = createConfigTokenStore<Account>({ configPath: path, multiUser: true })
        await store.set({ id: '1', email: 'a@b' }, 'tok-1')
        await expect(
            runLogout({ store, displayName: 'Test' }, { user: 'missing' }),
        ).rejects.toMatchObject({ code: 'AUTH_USER_NOT_FOUND' })
    })
})

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
    it('persists via acceptPastedToken', async () => {
        const store = createConfigTokenStore<Account>({ configPath: path, multiUser: false })
        const provider = pasteOnlyProvider()
        await runTokenSet(
            { provider, store, displayName: 'Test', envTokenVar: 'TEST_API_TOKEN' },
            'paste-me',
            {},
        )
        expect((await store.active())?.token).toBe('paste-me')
    })

    it('throws AUTH_INVALID_TOKEN on whitespace', async () => {
        const store = createConfigTokenStore<Account>({ configPath: path, multiUser: false })
        const provider = pasteOnlyProvider()
        await expect(
            runTokenSet(
                { provider, store, displayName: 'Test', envTokenVar: 'TEST_API_TOKEN' },
                '   ',
                {},
            ),
        ).rejects.toMatchObject({ code: 'AUTH_INVALID_TOKEN' })
    })
})
