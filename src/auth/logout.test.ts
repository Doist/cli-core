import { Command } from 'commander'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { formatJson } from '../json.js'
import { attachLogoutCommand } from './logout.js'
import type { TokenStore } from './types.js'

type Account = { id: string; label?: string; email: string }
type LogoutOverrides = Partial<Parameters<typeof attachLogoutCommand<Account>>[1]>

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
    overrides: LogoutOverrides = {},
    storeOverride?: TokenStore<Account>,
): {
    program: Command
    store: TokenStore<Account>
    logout: Command
    onCleared: ReturnType<typeof vi.fn>
} {
    const { store } = storeOverride ? { store: storeOverride } : buildStore()
    const program = new Command()
    program.exitOverride()
    const auth = program.command('auth')
    const onCleared = vi.fn()
    const logout = attachLogoutCommand<Account>(auth, {
        store,
        onCleared,
        ...overrides,
    })
    return { program, store, logout, onCleared }
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
            flags: {},
        })
    })

    it('emits a JSON success envelope under --json', async () => {
        const { program, onCleared } = build()

        await program.parseAsync(['node', 'cli', 'auth', 'logout', '--json'])

        expect(logSpy).toHaveBeenCalledWith(formatJson({ ok: true }))
        expect(onCleared).toHaveBeenCalledWith({
            account,
            view: { json: true, ndjson: false },
            flags: {},
        })
    })

    it('is silent on stdout under --ndjson', async () => {
        const { program, onCleared } = build()

        await program.parseAsync(['node', 'cli', 'auth', 'logout', '--ndjson'])

        expect(logSpy).not.toHaveBeenCalled()
        expect(onCleared).toHaveBeenCalledWith({
            account,
            view: { json: false, ndjson: true },
            flags: {},
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
            flags: {},
        })
    })

    it('skips store.active() when no hook is supplied', async () => {
        const built = buildStore()
        const { program } = build({ onCleared: undefined }, built.store)

        await program.parseAsync(['node', 'cli', 'auth', 'logout'])

        expect(built.activeSpy).not.toHaveBeenCalled()
        expect(built.clearSpy).toHaveBeenCalledTimes(1)
    })

    it('exposes consumer-attached options in flags but strips --json / --ndjson', async () => {
        const built = buildStore()
        const { program, logout, onCleared } = build({}, built.store)
        logout.option('--user <ref>', 'Multi-user selector')

        await program.parseAsync([
            'node',
            'cli',
            'auth',
            'logout',
            '--json',
            '--user',
            'me@example',
        ])

        expect(onCleared).toHaveBeenCalledWith({
            account,
            view: { json: true, ndjson: false },
            flags: { user: 'me@example' },
        })
    })

    it('runs hooks in order: active, clear, revoke, onCleared', async () => {
        const built = buildStore()
        const order: string[] = []
        built.activeSpy.mockImplementationOnce(async () => {
            order.push('active')
            return { token: 'tok', account }
        })
        built.clearSpy.mockImplementationOnce(async () => {
            order.push('clear')
        })
        const revokeToken = vi.fn(async () => {
            order.push('revoke')
        })
        const onCleared = vi.fn(() => {
            order.push('onCleared')
        })
        const { program } = build({ revokeToken, onCleared }, built.store)

        await program.parseAsync(['node', 'cli', 'auth', 'logout'])

        expect(order).toEqual(['active', 'clear', 'revoke', 'onCleared'])
    })

    it('invokes revokeToken with the snapshot after clear() runs', async () => {
        const built = buildStore()
        const revokeToken = vi.fn(async () => {})
        const { program } = build({ revokeToken }, built.store)

        await program.parseAsync(['node', 'cli', 'auth', 'logout'])

        expect(built.clearSpy).toHaveBeenCalledTimes(1)
        expect(revokeToken).toHaveBeenCalledWith({
            token: 'tok',
            account,
            view: { json: false, ndjson: false },
            flags: {},
        })
    })

    it('awaits revokeToken before firing onCleared', async () => {
        let resolveRevoke!: () => void
        const revokeToken = vi.fn(
            () =>
                new Promise<void>((resolve) => {
                    resolveRevoke = resolve
                }),
        )
        const built = buildStore()
        const { program, onCleared } = build({ revokeToken }, built.store)

        const parsing = program.parseAsync(['node', 'cli', 'auth', 'logout'])
        // Flush microtasks so the action body advances past `store.clear()` into `revokeToken`.
        await new Promise((resolve) => setImmediate(resolve))

        expect(built.clearSpy).toHaveBeenCalledTimes(1)
        expect(revokeToken).toHaveBeenCalledTimes(1)
        expect(onCleared).not.toHaveBeenCalled()

        resolveRevoke()
        await parsing

        expect(onCleared).toHaveBeenCalledTimes(1)
    })

    it('skips revokeToken when no prior session is stored but still clears', async () => {
        const built = buildStore(null)
        const revokeToken = vi.fn(async () => {})
        const { program } = build({ revokeToken, onCleared: undefined }, built.store)

        await program.parseAsync(['node', 'cli', 'auth', 'logout'])

        expect(revokeToken).not.toHaveBeenCalled()
        expect(built.clearSpy).toHaveBeenCalledTimes(1)
    })

    it('swallows revokeToken failures and still fires onCleared', async () => {
        const built = buildStore()
        const revokeToken = vi.fn(async () => {
            throw new Error('network down')
        })
        const { program, onCleared } = build({ revokeToken }, built.store)

        await expect(program.parseAsync(['node', 'cli', 'auth', 'logout'])).resolves.toBeDefined()

        expect(revokeToken).toHaveBeenCalledTimes(1)
        expect(built.clearSpy).toHaveBeenCalledTimes(1)
        expect(onCleared).toHaveBeenCalledWith({
            account,
            view: { json: false, ndjson: false },
            flags: {},
        })
    })

    it('proceeds to clear when store.active() throws', async () => {
        const built = buildStore()
        built.activeSpy.mockRejectedValueOnce(new Error('keychain unavailable'))
        const revokeToken = vi.fn(async () => {})
        const { program, onCleared } = build({ revokeToken }, built.store)

        await expect(program.parseAsync(['node', 'cli', 'auth', 'logout'])).resolves.toBeDefined()

        expect(built.clearSpy).toHaveBeenCalledTimes(1)
        expect(revokeToken).not.toHaveBeenCalled()
        expect(onCleared).toHaveBeenCalledWith({
            account: null,
            view: { json: false, ndjson: false },
            flags: {},
        })
    })

    it('reads store.active() when only revokeToken is supplied', async () => {
        const built = buildStore()
        const revokeToken = vi.fn(async () => {})
        const { program } = build({ revokeToken, onCleared: undefined }, built.store)

        await program.parseAsync(['node', 'cli', 'auth', 'logout'])

        expect(built.activeSpy).toHaveBeenCalledTimes(1)
        expect(revokeToken).toHaveBeenCalledTimes(1)
        expect(built.clearSpy).toHaveBeenCalledTimes(1)
    })

    it('exposes consumer-attached options in revokeToken flags', async () => {
        const built = buildStore()
        const revokeToken = vi.fn(async () => {})
        const { program, logout } = build({ revokeToken, onCleared: undefined }, built.store)
        logout.option('--user <ref>', 'Multi-user selector')

        await program.parseAsync([
            'node',
            'cli',
            'auth',
            'logout',
            '--json',
            '--user',
            'me@example',
        ])

        expect(revokeToken).toHaveBeenCalledWith({
            token: 'tok',
            account,
            view: { json: true, ndjson: false },
            flags: { user: 'me@example' },
        })
    })

    it('accepts a synchronous revokeToken', async () => {
        const built = buildStore()
        const revokeToken = vi.fn(() => {})
        const { program } = build({ revokeToken }, built.store)

        await program.parseAsync(['node', 'cli', 'auth', 'logout'])

        expect(revokeToken).toHaveBeenCalledTimes(1)
        expect(built.clearSpy).toHaveBeenCalledTimes(1)
    })

    it('works without an onCleared callback', async () => {
        const built = buildStore()
        const { program } = build({ onCleared: undefined }, built.store)

        await expect(program.parseAsync(['node', 'cli', 'auth', 'logout'])).resolves.toBeDefined()
        expect(built.clearSpy).toHaveBeenCalledTimes(1)
    })

    it('returns the new Command so the consumer can chain', () => {
        const { logout } = build()

        expect(logout.name()).toBe('logout')
    })

    it('honours a custom description', () => {
        const { logout } = build({ description: 'Sign out of Todoist' })

        expect(logout.description()).toBe('Sign out of Todoist')
    })
})
