import { Command } from 'commander'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { CliError } from '../errors.js'
import { attachStatusCommand } from './status.js'
import type { TokenStore } from './types.js'

type Account = { id: string; label?: string; email: string }

const account: Account = { id: '1', label: 'me', email: 'a@b' }

function buildStore(
    initial: { token: string; account: Account } | null = { token: 'tok', account },
): {
    store: TokenStore<Account>
    activeSpy: ReturnType<typeof vi.fn>
} {
    const activeSpy = vi.fn(async () => initial)
    const store: TokenStore<Account> = {
        active: activeSpy,
        set: vi.fn(),
        clear: vi.fn(),
    }
    return { store, activeSpy }
}

function build(
    overrides: Partial<Parameters<typeof attachStatusCommand<Account>>[1]> = {},
    storeOverride?: TokenStore<Account>,
): {
    program: Command
    store: TokenStore<Account>
    renderText: ReturnType<typeof vi.fn>
} {
    const store = storeOverride ?? buildStore().store
    const program = new Command()
    program.exitOverride()
    const auth = program.command('auth')
    const renderText = vi.fn((ctx: { account: Account }) => `Signed in as ${ctx.account.email}`)
    attachStatusCommand<Account>(auth, {
        store,
        renderText,
        ...overrides,
    })
    return { program, store, renderText }
}

describe('attachStatusCommand', () => {
    let logSpy: ReturnType<typeof vi.spyOn>

    beforeEach(() => {
        logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    })

    afterEach(() => {
        logSpy.mockRestore()
    })

    it('emits renderText output in plain mode', async () => {
        const { program, renderText } = build()

        await program.parseAsync(['node', 'cli', 'auth', 'status'])

        expect(renderText).toHaveBeenCalledWith({
            account,
            view: { json: false, ndjson: false },
        })
        expect(logSpy).toHaveBeenCalledWith('Signed in as a@b')
    })

    it('emits each line when renderText returns an array', async () => {
        const renderText = vi.fn(() => ['line 1', 'line 2', 'line 3'])
        const { program } = build({ renderText })

        await program.parseAsync(['node', 'cli', 'auth', 'status'])

        expect(logSpy).toHaveBeenCalledTimes(3)
        expect(logSpy).toHaveBeenNthCalledWith(1, 'line 1')
        expect(logSpy).toHaveBeenNthCalledWith(2, 'line 2')
        expect(logSpy).toHaveBeenNthCalledWith(3, 'line 3')
    })

    it('emits account as JSON by default under --json', async () => {
        const { program, renderText } = build()

        await program.parseAsync(['node', 'cli', 'auth', 'status', '--json'])

        expect(renderText).not.toHaveBeenCalled()
        expect(logSpy).toHaveBeenCalledWith(JSON.stringify(account, null, 2))
    })

    it('emits renderJson payload when supplied under --json', async () => {
        const renderJson = vi.fn(({ account: a }: { account: Account }) => ({
            id: a.id,
            email: a.email,
        }))
        const { program } = build({ renderJson })

        await program.parseAsync(['node', 'cli', 'auth', 'status', '--json'])

        expect(renderJson).toHaveBeenCalledWith({ account })
        expect(logSpy).toHaveBeenCalledWith(JSON.stringify({ id: '1', email: 'a@b' }, null, 2))
    })

    it('emits a single NDJSON line under --ndjson', async () => {
        const { program } = build()

        await program.parseAsync(['node', 'cli', 'auth', 'status', '--ndjson'])

        expect(logSpy).toHaveBeenCalledWith(JSON.stringify(account))
    })

    it('runs fetchLive and uses its returned account for rendering', async () => {
        const live: Account = { id: '1', label: 'me', email: 'live@b' }
        const fetchLive = vi.fn(async () => live)
        const { program, renderText } = build({ fetchLive })

        await program.parseAsync(['node', 'cli', 'auth', 'status'])

        expect(fetchLive).toHaveBeenCalledWith({
            account,
            token: 'tok',
            view: { json: false, ndjson: false },
        })
        expect(renderText).toHaveBeenCalledWith({
            account: live,
            view: { json: false, ndjson: false },
        })
        expect(logSpy).toHaveBeenCalledWith('Signed in as live@b')
    })

    it('propagates fetchLive throws', async () => {
        const fetchLive = vi.fn(async () => {
            throw new CliError('NO_TOKEN', 'Token expired')
        })
        const { program } = build({ fetchLive })

        await expect(program.parseAsync(['node', 'cli', 'auth', 'status'])).rejects.toMatchObject({
            constructor: CliError,
            code: 'NO_TOKEN',
        })
    })

    it('throws CliError(NOT_AUTHENTICATED) when the store is empty and no callback is set', async () => {
        const { program } = build({}, buildStore(null).store)

        await expect(program.parseAsync(['node', 'cli', 'auth', 'status'])).rejects.toMatchObject({
            constructor: CliError,
            code: 'NOT_AUTHENTICATED',
        })
        expect(logSpy).not.toHaveBeenCalled()
    })

    it('invokes onNotAuthenticated when supplied instead of throwing', async () => {
        const onNotAuthenticated = vi.fn()
        const { program, renderText } = build({ onNotAuthenticated }, buildStore(null).store)

        await program.parseAsync(['node', 'cli', 'auth', 'status'])

        expect(onNotAuthenticated).toHaveBeenCalledWith({ json: false, ndjson: false })
        expect(renderText).not.toHaveBeenCalled()
    })

    it('returns the new Command so the consumer can chain', () => {
        const program = new Command()
        const auth = program.command('auth')
        const status = attachStatusCommand<Account>(auth, {
            store: buildStore().store,
            renderText: () => 'ok',
        })

        expect(status.name()).toBe('status')
    })
})
