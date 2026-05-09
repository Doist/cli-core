import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createConfigTokenStore } from './config.js'

type Account = { id: string; label?: string; email: string }

let dir: string
let path: string

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cli-core-auth-store-'))
    path = join(dir, 'config.json')
})

afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
})

describe('createConfigTokenStore', () => {
    it('round-trips set → active and overwrites on re-set', async () => {
        const store = createConfigTokenStore<Account>({ configPath: path })

        await store.set({ id: '1', email: 'a@b' }, 'tok-1')
        expect(await store.active()).toEqual({
            token: 'tok-1',
            account: { id: '1', email: 'a@b' },
        })

        await store.set({ id: '1', email: 'changed@b' }, 'tok-2')
        expect(await store.active()).toEqual({
            token: 'tok-2',
            account: { id: '1', email: 'changed@b' },
        })
    })

    it('clear empties the store', async () => {
        const store = createConfigTokenStore<Account>({ configPath: path })
        await store.set({ id: '1', email: 'a@b' }, 'tok-1')
        await store.clear()
        expect(await store.active()).toBeNull()
    })

    it('honours custom storageKey to coexist with other config sections', async () => {
        const store = createConfigTokenStore<Account>({
            configPath: path,
            storageKey: 'my_auth',
        })
        await store.set({ id: '1', email: 'a@b' }, 'tok-1')
        const raw = JSON.parse(await readFile(path, 'utf-8')) as Record<string, unknown>
        expect(raw.my_auth).toEqual({
            account: { id: '1', email: 'a@b' },
            token: 'tok-1',
        })
    })

    it('backend() reports config', async () => {
        const store = createConfigTokenStore<Account>({ configPath: path })
        expect(await store.backend()).toBe('config')
    })
})
