import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createConfigTokenStore } from '../store/config.js'
import { runStatus } from './status.js'

// Smoke-level: env override (incl. --user bypass) + multi-user listing. JSON
// envelope shape is also exercised via register.test.ts.

type Account = { id: string; label?: string; email: string }

let dir: string
let path: string
let logs: string[]
let originalLog: typeof console.log

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cli-core-status-'))
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

describe('runStatus', () => {
    it('reports backend=env when env var is set and no --user', async () => {
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

    it('--user bypasses the env override so the stored account can be inspected', async () => {
        process.env.TEST_API_TOKEN = 'env-tok'
        const store = createConfigTokenStore<Account>({ configPath: path, multiUser: true })
        await store.set({ id: '1', email: 'a@b' }, 'tok-1')

        await runStatus(
            { store, displayName: 'Test', envTokenVar: 'TEST_API_TOKEN' },
            { user: '1', json: true },
        )
        const out = JSON.parse(logs[0]) as {
            backend: string
            envTokenSet: boolean
            activeAccount: Account
        }
        expect(out.backend).toBe('config')
        expect(out.envTokenSet).toBe(true)
        expect(out.activeAccount).toEqual({ id: '1', email: 'a@b' })
    })

    it('lists multiple accounts in multi-user mode', async () => {
        const store = createConfigTokenStore<Account>({ configPath: path, multiUser: true })
        await store.set({ id: '1', label: 'Alice', email: 'a@b' }, 'tok-1')
        await store.set({ id: '2', label: 'Bob', email: 'b@b' }, 'tok-2')
        await runStatus(
            { store, displayName: 'Test', envTokenVar: 'TEST_API_TOKEN' },
            { json: true },
        )
        const out = JSON.parse(logs[0]) as { accounts: Account[]; activeAccount: Account }
        expect(out.accounts).toHaveLength(2)
        expect(out.activeAccount.id).toBe('1')
    })
})
