import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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

async function readJson(): Promise<Record<string, unknown>> {
    const text = await readFile(path, 'utf-8')
    return JSON.parse(text) as Record<string, unknown>
}

describe('createConfigTokenStore — single-user', () => {
    it('round-trips one account + token', async () => {
        const store = createConfigTokenStore<Account>({ configPath: path, multiUser: false })

        await store.set({ id: '1', email: 'a@b' }, 'tok-1')
        expect(await store.list()).toEqual([{ id: '1', email: 'a@b' }])
        expect(await store.active()).toEqual({
            token: 'tok-1',
            account: { id: '1', email: 'a@b' },
        })
        expect(await store.get('1')).toEqual({
            token: 'tok-1',
            account: { id: '1', email: 'a@b' },
        })
        expect(await store.get('missing')).toBeNull()
    })

    it('overwrites on re-set', async () => {
        const store = createConfigTokenStore<Account>({ configPath: path, multiUser: false })
        await store.set({ id: '1', email: 'a@b' }, 'tok-1')
        await store.set({ id: '1', email: 'changed@b' }, 'tok-2')
        expect(await store.active()).toEqual({
            token: 'tok-2',
            account: { id: '1', email: 'changed@b' },
        })
    })

    it('delete removes the slot when ids match', async () => {
        const store = createConfigTokenStore<Account>({ configPath: path, multiUser: false })
        await store.set({ id: '1', email: 'a@b' }, 'tok-1')
        await store.delete('1')
        expect(await store.active()).toBeNull()
    })

    it('clear empties the slot', async () => {
        const store = createConfigTokenStore<Account>({ configPath: path, multiUser: false })
        await store.set({ id: '1', email: 'a@b' }, 'tok-1')
        await store.clear()
        expect(await store.active()).toBeNull()
    })

    it('backend() reports config', async () => {
        const store = createConfigTokenStore<Account>({ configPath: path, multiUser: false })
        expect(await store.backend()).toBe('config')
    })
})

describe('createConfigTokenStore — multi-user', () => {
    it('stores accounts and tokens under separate top-level keys', async () => {
        const store = createConfigTokenStore<Account>({ configPath: path, multiUser: true })
        await store.set({ id: '1', email: 'a@b' }, 'tok-1')
        await store.set({ id: '2', email: 'c@d' }, 'tok-2')

        const raw = await readJson()
        expect(raw.auth_accounts).toEqual([
            { id: '1', email: 'a@b' },
            { id: '2', email: 'c@d' },
        ])
        expect(raw.auth_tokens).toEqual({ '1': 'tok-1', '2': 'tok-2' })
        expect(raw.auth_active_id).toBe('1')
    })

    it('list returns every account, get/active resolve tokens', async () => {
        const store = createConfigTokenStore<Account>({ configPath: path, multiUser: true })
        await store.set({ id: '1', email: 'a@b' }, 'tok-1')
        await store.set({ id: '2', email: 'c@d' }, 'tok-2')

        expect((await store.list()).length).toBe(2)
        expect(await store.active()).toEqual({
            token: 'tok-1',
            account: { id: '1', email: 'a@b' },
        })
        expect(await store.get('2')).toEqual({
            token: 'tok-2',
            account: { id: '2', email: 'c@d' },
        })
    })

    it('setActive switches the active pointer; throws on unknown id', async () => {
        const store = createConfigTokenStore<Account>({ configPath: path, multiUser: true })
        await store.set({ id: '1', email: 'a@b' }, 'tok-1')
        await store.set({ id: '2', email: 'c@d' }, 'tok-2')
        await store.setActive('2')
        expect((await store.active())?.account.id).toBe('2')
        await expect(store.setActive('missing')).rejects.toMatchObject({
            code: 'AUTH_USER_NOT_FOUND',
        })
    })

    it('delete removes one account; reassigns active when needed', async () => {
        const store = createConfigTokenStore<Account>({ configPath: path, multiUser: true })
        await store.set({ id: '1', email: 'a@b' }, 'tok-1')
        await store.set({ id: '2', email: 'c@d' }, 'tok-2')
        await store.delete('1')
        const raw = await readJson()
        expect(raw.auth_accounts).toEqual([{ id: '2', email: 'c@d' }])
        expect(raw.auth_tokens).toEqual({ '2': 'tok-2' })
        expect(raw.auth_active_id).toBe('2')
    })

    it('clear empties accounts + tokens + active', async () => {
        const store = createConfigTokenStore<Account>({ configPath: path, multiUser: true })
        await store.set({ id: '1', email: 'a@b' }, 'tok-1')
        await store.clear()
        const raw = await readJson()
        expect(raw.auth_accounts).toEqual([])
        expect(raw.auth_tokens).toEqual({})
        expect(raw.auth_active_id).toBeUndefined()
    })

    it('honours custom keys (matches an existing CLI shape)', async () => {
        const store = createConfigTokenStore<Account>({
            configPath: path,
            multiUser: true,
            accountsKey: 'users',
            activeKey: 'active_user',
            tokensKey: 'user_tokens',
        })
        await store.set({ id: '1', email: 'a@b' }, 'tok-1')
        const raw = await readJson()
        expect(raw.users).toBeDefined()
        expect(raw.user_tokens).toEqual({ '1': 'tok-1' })
        expect(raw.active_user).toBe('1')
    })
})

describe('createConfigTokenStore — migration hook', () => {
    it('runs once on first read when target shape is absent and a hook is provided', async () => {
        // Seed a legacy v1 single-token config.
        await writeFile(
            path,
            JSON.stringify({ token: 'legacy-token', authMode: 'read-write' }),
            'utf-8',
        )

        const migrate = vi.fn(async (raw: Record<string, unknown>) => {
            expect(raw.token).toBe('legacy-token')
            return {
                accounts: [
                    { id: 'u1', email: 'a@b', token: raw.token } as Account & { token: string },
                ],
                activeId: 'u1',
            }
        })

        const store = createConfigTokenStore<Account>({
            configPath: path,
            multiUser: true,
            migrate,
        })

        const active = await store.active()
        expect(active).toEqual({
            token: 'legacy-token',
            account: { id: 'u1', email: 'a@b' },
        })
        expect(migrate).toHaveBeenCalledTimes(1)

        // Subsequent calls do not re-run migration even though instance is the same.
        await store.list()
        expect(migrate).toHaveBeenCalledTimes(1)

        // Persisted shape no longer has the legacy `token` field on the account.
        const raw = await readJson()
        expect(raw.auth_accounts).toEqual([{ id: 'u1', email: 'a@b' }])
        expect(raw.auth_tokens).toEqual({ u1: 'legacy-token' })
    })

    it('skips migration when target shape already present', async () => {
        const migrate = vi.fn(async () => null)
        const store = createConfigTokenStore<Account>({
            configPath: path,
            multiUser: true,
            migrate,
        })
        await store.set({ id: '1', email: 'a@b' }, 'tok')
        await store.list()
        expect(migrate).not.toHaveBeenCalled()
    })
})
