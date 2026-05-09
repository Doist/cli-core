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
    return JSON.parse(await readFile(path, 'utf-8')) as Record<string, unknown>
}

// Cases that behave identically across single- and multi-user modes are run
// against both via `it.each` so every cardinality is covered without parallel
// blocks. Multi-user-specific behaviour (account list shape, setActive,
// custom keys) lives in its own block below.
describe.each([{ multiUser: false }, { multiUser: true }])(
    'createConfigTokenStore (multiUser=$multiUser)',
    ({ multiUser }) => {
        it('round-trips set → list/get/active and overwrites on re-set', async () => {
            const store = createConfigTokenStore<Account>({ configPath: path, multiUser })

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

            await store.set({ id: '1', email: 'changed@b' }, 'tok-2')
            expect(await store.active()).toEqual({
                token: 'tok-2',
                account: { id: '1', email: 'changed@b' },
            })
        })

        it('delete drops the matching account; clear empties the store', async () => {
            const store = createConfigTokenStore<Account>({ configPath: path, multiUser })
            await store.set({ id: '1', email: 'a@b' }, 'tok-1')
            await store.delete('1')
            expect(await store.active()).toBeNull()

            await store.set({ id: '1', email: 'a@b' }, 'tok-1')
            await store.clear()
            expect(await store.active()).toBeNull()
        })

        it('backend() reports config', async () => {
            const store = createConfigTokenStore<Account>({ configPath: path, multiUser })
            expect(await store.backend()).toBe('config')
        })
    },
)

describe('createConfigTokenStore — multi-user only', () => {
    it('keeps accounts and tokens under separate top-level keys; first set seeds active_id', async () => {
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

    it('delete reassigns active when removing the current active account', async () => {
        const store = createConfigTokenStore<Account>({ configPath: path, multiUser: true })
        await store.set({ id: '1', email: 'a@b' }, 'tok-1')
        await store.set({ id: '2', email: 'c@d' }, 'tok-2')
        await store.delete('1')
        const raw = await readJson()
        expect(raw.auth_active_id).toBe('2')
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
    it('runs once on first read when target shape is absent', async () => {
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
        expect(active).toEqual({ token: 'legacy-token', account: { id: 'u1', email: 'a@b' } })
        expect(migrate).toHaveBeenCalledTimes(1)

        // Subsequent reads must not re-run the migration.
        await store.list()
        expect(migrate).toHaveBeenCalledTimes(1)

        // Persisted shape strips the legacy `token` field from the account.
        const raw = await readJson()
        expect(raw.auth_accounts).toEqual([{ id: 'u1', email: 'a@b' }])
        expect(raw.auth_tokens).toEqual({ u1: 'legacy-token' })
    })
})
