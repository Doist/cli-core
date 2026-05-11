import { Command } from 'commander'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { attachLogoutCommand } from './logout.js'
import type { TokenStore } from './types.js'

type Account = { id: string; label?: string; email: string }

const account: Account = { id: '1', label: 'me', email: 'a@b' }

function buildStore(
    initial: { token: string; account: Account } | null = { token: 'tok', account },
): {
    store: TokenStore<Account>
    activeSpy: ReturnType<typeof vi.fn>
    clearSpy: ReturnType<typeof vi.fn>
} {
    const activeSpy = vi.fn(async () => initial)
    const clearSpy = vi.fn(async () => undefined)
    const store: TokenStore<Account> = {
        active: activeSpy,
        set: vi.fn(),
        clear: clearSpy,
    }
    return { store, activeSpy, clearSpy }
}

function build(
    overrides: Partial<Parameters<typeof attachLogoutCommand<Account>>[1]> = {},
    storeOverride?: TokenStore<Account>,
): {
    program: Command
    store: TokenStore<Account>
    onCleared: ReturnType<typeof vi.fn>
} {
    const { store } = storeOverride ? { store: storeOverride } : buildStore()
    const program = new Command()
    program.exitOverride()
    const auth = program.command('auth')
    const onCleared = vi.fn()
    attachLogoutCommand<Account>(auth, {
        store,
        onCleared,
        ...overrides,
    })
    return { program, store, onCleared }
}

describe('attachLogoutCommand', () => {
    let logSpy: ReturnType<typeof vi.spyOn>

    beforeEach(() => {
        logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    })

    afterEach(() => {
        logSpy.mockRestore()
    })

    it('clears the store and emits the human success line in plain mode', async () => {
        const built = buildStore()
        const { program, onCleared } = build({}, built.store)

        await program.parseAsync(['node', 'cli', 'auth', 'logout'])

        expect(built.activeSpy).toHaveBeenCalledTimes(1)
        expect(built.clearSpy).toHaveBeenCalledTimes(1)
        expect(logSpy).toHaveBeenCalledWith('✓ Logged out')
        expect(onCleared).toHaveBeenCalledWith({
            account,
            view: { json: false, ndjson: false },
        })
    })

    it('emits a JSON success envelope under --json', async () => {
        const { program, onCleared } = build()

        await program.parseAsync(['node', 'cli', 'auth', 'logout', '--json'])

        expect(logSpy).toHaveBeenCalledWith(JSON.stringify({ ok: true }, null, 2))
        expect(onCleared).toHaveBeenCalledWith({
            account,
            view: { json: true, ndjson: false },
        })
    })

    it('is silent on stdout under --ndjson', async () => {
        const { program, onCleared } = build()

        await program.parseAsync(['node', 'cli', 'auth', 'logout', '--ndjson'])

        expect(logSpy).not.toHaveBeenCalled()
        expect(onCleared).toHaveBeenCalledWith({
            account,
            view: { json: false, ndjson: true },
        })
    })

    it('passes a null account when nothing was stored', async () => {
        const built = buildStore(null)
        const { program, onCleared } = build({}, built.store)

        await program.parseAsync(['node', 'cli', 'auth', 'logout'])

        expect(built.clearSpy).toHaveBeenCalledTimes(1)
        expect(onCleared).toHaveBeenCalledWith({
            account: null,
            view: { json: false, ndjson: false },
        })
    })

    it('snapshots the active account before clear() runs', async () => {
        const built = buildStore()
        const order: string[] = []
        ;(built.store.active as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => {
            order.push('active')
            return { token: 'tok', account }
        })
        ;(built.store.clear as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => {
            order.push('clear')
        })
        const onCleared = vi.fn(() => {
            order.push('onCleared')
        })
        const { program } = build({ onCleared }, built.store)

        await program.parseAsync(['node', 'cli', 'auth', 'logout'])

        expect(order).toEqual(['active', 'clear', 'onCleared'])
    })

    it('works without an onCleared callback', async () => {
        const program = new Command()
        program.exitOverride()
        const auth = program.command('auth')
        const built = buildStore()
        attachLogoutCommand<Account>(auth, { store: built.store })

        await expect(program.parseAsync(['node', 'cli', 'auth', 'logout'])).resolves.toBeDefined()
        expect(built.clearSpy).toHaveBeenCalledTimes(1)
    })

    it('returns the new Command so the consumer can chain', () => {
        const program = new Command()
        const auth = program.command('auth')
        const built = buildStore()
        const logout = attachLogoutCommand<Account>(auth, { store: built.store })

        expect(logout.name()).toBe('logout')
    })

    it('honours a custom description', () => {
        const program = new Command()
        const auth = program.command('auth')
        const built = buildStore()
        const logout = attachLogoutCommand<Account>(auth, {
            store: built.store,
            description: 'Sign out of Todoist',
        })

        expect(logout.description()).toBe('Sign out of Todoist')
    })
})
