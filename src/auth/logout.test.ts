import { Command } from 'commander'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { CliError } from '../errors.js'
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
        list: vi.fn(async () => (initial ? [{ account: initial.account, isDefault: true }] : [])),
        setDefault: vi.fn(),
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

        expect(built.activeSpy).toHaveBeenCalledWith(undefined)
        expect(built.clearSpy).toHaveBeenCalledWith(undefined)
        expect(logSpy).toHaveBeenCalledWith('✓ Logged out')
        expect(onCleared).toHaveBeenCalledWith({
            account,
            ref: undefined,
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
            ref: undefined,
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
            ref: undefined,
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
            ref: undefined,
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

    it('strips --json / --ndjson / --user from flags but exposes consumer-attached options', async () => {
        const built = buildStore()
        const { program, logout, onCleared } = build({}, built.store)
        logout.option('--full', 'Consumer-attached')

        await program.parseAsync([
            'node',
            'cli',
            'auth',
            'logout',
            '--json',
            '--user',
            'me@example',
            '--full',
        ])

        expect(built.activeSpy).toHaveBeenCalledWith('me@example')
        expect(built.clearSpy).toHaveBeenCalledWith('me@example')
        expect(onCleared).toHaveBeenCalledWith({
            account,
            ref: 'me@example',
            view: { json: true, ndjson: false },
            flags: { full: true },
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
            ref: undefined,
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
            ref: undefined,
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
            ref: undefined,
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

    it('exposes consumer-attached options in revokeToken flags and strips --user', async () => {
        const built = buildStore()
        const revokeToken = vi.fn(async () => {})
        const { program, logout } = build({ revokeToken, onCleared: undefined }, built.store)
        logout.option('--full', 'Consumer-attached')

        await program.parseAsync([
            'node',
            'cli',
            'auth',
            'logout',
            '--json',
            '--user',
            'me@example',
            '--full',
        ])

        expect(built.activeSpy).toHaveBeenCalledWith('me@example')
        expect(revokeToken).toHaveBeenCalledWith({
            token: 'tok',
            account,
            ref: 'me@example',
            view: { json: true, ndjson: false },
            flags: { full: true },
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

    it('threads --user ref to store.active(ref) and store.clear(ref)', async () => {
        const built = buildStore()
        const { program, onCleared } = build({}, built.store)

        await program.parseAsync(['node', 'cli', 'auth', 'logout', '--user', 'alice@example'])

        expect(built.activeSpy).toHaveBeenCalledWith('alice@example')
        expect(built.clearSpy).toHaveBeenCalledWith('alice@example')
        expect(onCleared).toHaveBeenCalledWith({
            account,
            ref: 'alice@example',
            view: { json: false, ndjson: false },
            flags: {},
        })
    })

    it('throws ACCOUNT_NOT_FOUND on explicit --user miss before clearing', async () => {
        // Store reports null for the requested ref (no match). Without the
        // explicit-ref guard, `logout --user ghost` would silently print
        // `✓ Logged out` after a no-op clear.
        const built = buildStore(null)
        const { program } = build({ onCleared: undefined }, built.store)

        await expect(
            program.parseAsync(['node', 'cli', 'auth', 'logout', '--user', 'ghost']),
        ).rejects.toMatchObject({
            constructor: CliError,
            code: 'ACCOUNT_NOT_FOUND',
        })
        expect(built.clearSpy).not.toHaveBeenCalled()
        expect(logSpy).not.toHaveBeenCalled()
    })

    it('proceeds with clear(ref) when active(ref) throws AUTH_STORE_READ_FAILED', async () => {
        // A matching record exists but the keyring is offline, so the
        // pre-flight can't return a snapshot. `logout --user me` should
        // still clear the record (it doesn't need the token); only the
        // optional `revokeToken` is skipped because there's no token to
        // send to the server.
        const built = buildStore()
        built.activeSpy.mockRejectedValueOnce(
            new CliError('AUTH_STORE_READ_FAILED', 'keyring offline'),
        )
        const revokeSpy = vi.fn()
        const { program, onCleared } = build({ revokeToken: revokeSpy }, built.store)

        await program.parseAsync(['node', 'cli', 'auth', 'logout', '--user', 'me'])

        expect(built.clearSpy).toHaveBeenCalledWith('me')
        expect(revokeSpy).not.toHaveBeenCalled()
        expect(logSpy).toHaveBeenCalledWith('✓ Logged out')
        // `account` is null (no readable snapshot) but `ref` is populated, so
        // consumers can distinguish "nothing was stored" from "cleared an
        // unreadable record".
        expect(onCleared).toHaveBeenCalledWith({
            account: null,
            ref: 'me',
            view: { json: false, ndjson: false },
            flags: {},
        })
    })

    it('tolerates AUTH_STORE_READ_FAILED when --user alone triggers the pre-flight (no hooks)', async () => {
        // With neither `revokeToken` nor `onCleared` set, the snapshot only
        // runs because `--user <ref>` was supplied. The recovery branch must
        // still kick in there — otherwise `logout --user me` would abort with
        // `AUTH_STORE_READ_FAILED` in the bare-config case.
        const built = buildStore()
        built.activeSpy.mockRejectedValueOnce(
            new CliError('AUTH_STORE_READ_FAILED', 'keyring offline'),
        )
        const { program } = build({ onCleared: undefined }, built.store)

        await program.parseAsync(['node', 'cli', 'auth', 'logout', '--user', 'me'])

        expect(built.clearSpy).toHaveBeenCalledWith('me')
        expect(logSpy).toHaveBeenCalledWith('✓ Logged out')
    })

    it('still propagates non-read errors from the snapshot pre-flight', async () => {
        const thrown = new CliError('AUTH_STORE_WRITE_FAILED', 'something else')
        const built = buildStore()
        built.activeSpy.mockRejectedValueOnce(thrown)
        const { program } = build({ onCleared: undefined }, built.store)

        // Exact-instance match (`toBe`) — a wrap-and-rethrow with the same
        // code would otherwise pass.
        await expect(
            program.parseAsync(['node', 'cli', 'auth', 'logout', '--user', 'me']),
        ).rejects.toBe(thrown)
        expect(built.clearSpy).not.toHaveBeenCalled()
    })
})
