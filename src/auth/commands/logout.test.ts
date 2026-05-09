import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createConfigTokenStore } from '../store/config.js'
import { runLogout } from './logout.js'

type Account = { id: string; label?: string; email: string }

let dir: string
let path: string
let logs: string[]
let originalLog: typeof console.log

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cli-core-logout-'))
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

describe('runLogout', () => {
    it('removes the active account by default', async () => {
        const store = createConfigTokenStore<Account>({ configPath: path, multiUser: true })
        await store.set({ id: '1', email: 'a@b' }, 'tok-1')
        await store.set({ id: '2', email: 'b@b' }, 'tok-2')
        await runLogout({ store, displayName: 'Test' }, {})
        expect((await store.list()).map((a) => a.id)).toEqual(['2'])
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
