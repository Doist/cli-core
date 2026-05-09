import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createConfigTokenStore } from './config.js'
import type { KeyringImpl } from './keyring.js'
import { createKeyringTokenStore } from './keyring.js'

type Account = { id: string; label?: string; email: string }

let dir: string
let path: string

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cli-core-keyring-'))
    path = join(dir, 'config.json')
})

afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
})

function makeFakeKeyring(): { impl: KeyringImpl; data: Map<string, string> } {
    const data = new Map<string, string>()
    const impl: KeyringImpl = {
        Entry: class {
            private readonly key: string
            constructor(service: string, account: string) {
                this.key = `${service}::${account}`
            }
            getPassword() {
                return data.get(this.key) ?? null
            }
            setPassword(password: string) {
                data.set(this.key, password)
            }
            deletePassword() {
                return data.delete(this.key)
            }
        },
    }
    return { impl, data }
}

function makeBrokenKeyring(): KeyringImpl {
    return {
        Entry: class {
            constructor() {}
            getPassword(): string | null {
                throw new Error('keyring unavailable')
            }
            setPassword(): void {
                throw new Error('keyring unavailable')
            }
            deletePassword(): boolean {
                throw new Error('keyring unavailable')
            }
        },
    }
}

describe('createKeyringTokenStore', () => {
    it('writes token to keyring; account metadata to fallback', async () => {
        const { impl, data } = makeFakeKeyring()
        const fallback = createConfigTokenStore<Account>({ configPath: path, multiUser: true })
        const store = createKeyringTokenStore<Account>({
            serviceName: 'test-cli',
            fallback,
            keyringImpl: impl,
        })

        await store.set({ id: '1', email: 'a@b' }, 'tok-1')
        expect(data.get('test-cli::user-1')).toBe('tok-1')
        expect(await store.get('1')).toEqual({
            token: 'tok-1',
            account: { id: '1', email: 'a@b' },
        })
        expect(await store.backend()).toBe('keyring')
    })

    it('falls back to config store when keyring write fails', async () => {
        const fallback = createConfigTokenStore<Account>({ configPath: path, multiUser: true })
        const store = createKeyringTokenStore<Account>({
            serviceName: 'test-cli',
            fallback,
            keyringImpl: makeBrokenKeyring(),
        })

        await store.set({ id: '1', email: 'a@b' }, 'tok-1')
        const got = await store.get('1')
        expect(got).toEqual({ token: 'tok-1', account: { id: '1', email: 'a@b' } })
        expect(await store.backend()).toBe('config')
    })

    it('falls back to config store when keyring module fails to import', async () => {
        const fallback = createConfigTokenStore<Account>({ configPath: path, multiUser: true })
        const store = createKeyringTokenStore<Account>({
            serviceName: 'test-cli',
            fallback,
            keyringImpl: () => Promise.reject(new Error('module not installed')),
        })

        await store.set({ id: '1', email: 'a@b' }, 'tok-1')
        expect(await store.get('1')).toEqual({
            token: 'tok-1',
            account: { id: '1', email: 'a@b' },
        })
        expect(await store.backend()).toBe('config')
    })

    it('delete removes from keyring and fallback', async () => {
        const { impl, data } = makeFakeKeyring()
        const fallback = createConfigTokenStore<Account>({ configPath: path, multiUser: true })
        const store = createKeyringTokenStore<Account>({
            serviceName: 'test-cli',
            fallback,
            keyringImpl: impl,
        })

        await store.set({ id: '1', email: 'a@b' }, 'tok-1')
        await store.delete('1')
        expect(data.has('test-cli::user-1')).toBe(false)
        expect(await store.list()).toEqual([])
    })

    it('clear wipes keyring entries for every known account + fallback', async () => {
        const { impl, data } = makeFakeKeyring()
        const fallback = createConfigTokenStore<Account>({ configPath: path, multiUser: true })
        const store = createKeyringTokenStore<Account>({
            serviceName: 'test-cli',
            fallback,
            keyringImpl: impl,
        })

        await store.set({ id: '1', email: 'a@b' }, 'tok-1')
        await store.set({ id: '2', email: 'c@d' }, 'tok-2')
        await store.clear()

        expect(data.size).toBe(0)
        expect(await store.list()).toEqual([])
    })

    it('honours custom accountName format', async () => {
        const { impl, data } = makeFakeKeyring()
        const fallback = createConfigTokenStore<Account>({ configPath: path, multiUser: true })
        const store = createKeyringTokenStore<Account>({
            serviceName: 'test-cli',
            fallback,
            keyringImpl: impl,
            accountName: (id) => `custom-${id}`,
        })

        await store.set({ id: '1', email: 'a@b' }, 'tok-1')
        expect(data.get('test-cli::custom-1')).toBe('tok-1')
    })

    it('lazy-import is called only once', async () => {
        const { impl } = makeFakeKeyring()
        const factory = vi.fn(async () => impl)
        const fallback = createConfigTokenStore<Account>({ configPath: path, multiUser: true })
        const store = createKeyringTokenStore<Account>({
            serviceName: 'test-cli',
            fallback,
            keyringImpl: factory,
        })

        await store.set({ id: '1', email: 'a@b' }, 'tok-1')
        await store.set({ id: '2', email: 'c@d' }, 'tok-2')
        await store.get('1')
        expect(factory).toHaveBeenCalledTimes(1)
    })
})
