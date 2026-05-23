import type { Command } from 'commander'
import { describe, expect, it, vi } from 'vitest'

import { CliError } from '../errors.js'
import { formatJson, formatNdjson } from '../json.js'
import {
    type TestAccount as Account,
    type TokenStoreHarness,
    alanGrant,
    buildSingleEntryStore,
} from '../test-support/accounts.js'
import { buildProgram, installConsoleLogSpy } from '../test-support/cli-harness.js'
import { attachStatusCommand } from './status.js'
import type { TokenStore } from './types.js'

const account = alanGrant

function buildStore(
    initial: { token: string; account: Account } | null = { token: 'tok', account },
): TokenStoreHarness<Account> {
    // Drop the bundle read so `fetchLive` resolves via `active()` (access token
    // only) — these suites assert the no-`bundle` `fetchLive` ctx shape.
    return buildSingleEntryStore(initial, { activeBundle: undefined })
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
    const { program, parent: auth } = buildProgram('auth')
    const renderText = vi.fn((ctx: { account: Account }) => `Signed in as ${ctx.account.email}`)
    attachStatusCommand<Account>(auth, {
        store,
        renderText,
        ...overrides,
    })
    return { program, store, renderText }
}

describe('attachStatusCommand', () => {
    const logSpy = installConsoleLogSpy()

    it('emits renderText output in plain mode', async () => {
        const { program, renderText } = build()

        await program.parseAsync(['node', 'cli', 'auth', 'status'])

        expect(renderText).toHaveBeenCalledWith({
            account,
            view: { json: false, ndjson: false },
            flags: {},
        })
        expect(logSpy()).toHaveBeenCalledWith('Signed in as alan@ingen.com')
    })

    it('emits each line when renderText returns an array', async () => {
        const renderText = vi.fn(() => ['line 1', 'line 2', 'line 3'])
        const { program } = build({ renderText })

        await program.parseAsync(['node', 'cli', 'auth', 'status'])

        const emitted = logSpy()
            .mock.calls.map((call: unknown[]) => call[0])
            .join('\n')
        expect(emitted).toBe('line 1\nline 2\nline 3')
    })

    it('emits account as JSON by default under --json', async () => {
        const { program, renderText } = build()

        await program.parseAsync(['node', 'cli', 'auth', 'status', '--json'])

        expect(renderText).not.toHaveBeenCalled()
        expect(logSpy()).toHaveBeenCalledWith(formatJson(account))
    })

    it('emits renderJson payload when supplied under --json', async () => {
        const renderJson = vi.fn(({ account: a }: { account: Account }) => ({
            id: a.id,
            email: a.email,
        }))
        const { program } = build({ renderJson })

        await program.parseAsync(['node', 'cli', 'auth', 'status', '--json'])

        expect(renderJson).toHaveBeenCalledWith({ account, flags: {} })
        expect(logSpy()).toHaveBeenCalledWith(formatJson({ id: '1', email: 'alan@ingen.com' }))
    })

    it('emits a single NDJSON line under --ndjson', async () => {
        const { program } = build()

        await program.parseAsync(['node', 'cli', 'auth', 'status', '--ndjson'])

        expect(logSpy()).toHaveBeenCalledWith(formatNdjson([account]))
    })

    it('does not invoke renderJson in human mode', async () => {
        const renderJson = vi.fn(({ account: a }: { account: Account }) => ({ id: a.id }))
        const { program } = build({ renderJson })

        await program.parseAsync(['node', 'cli', 'auth', 'status'])

        expect(renderJson).not.toHaveBeenCalled()
    })

    it('runs fetchLive and uses its returned account for rendering', async () => {
        const live: Account = { ...alanGrant, email: 'live@ingen.com' }
        const fetchLive = vi.fn(async () => live)
        const { program, renderText } = build({ fetchLive })

        await program.parseAsync(['node', 'cli', 'auth', 'status'])

        expect(fetchLive).toHaveBeenCalledWith({
            account,
            token: 'tok',
            view: { json: false, ndjson: false },
            flags: {},
        })
        expect(renderText).toHaveBeenCalledWith({
            account: live,
            view: { json: false, ndjson: false },
            flags: {},
        })
        expect(logSpy()).toHaveBeenCalledWith('Signed in as live@ingen.com')
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
        expect(logSpy()).not.toHaveBeenCalled()
    })

    it('awaits an async onNotAuthenticated when supplied instead of throwing', async () => {
        const order: string[] = []
        const onNotAuthenticated = vi.fn(async () => {
            await Promise.resolve()
            order.push('onNotAuthenticated')
        })
        const { program, renderText } = build({ onNotAuthenticated }, buildStore(null).store)

        await program.parseAsync(['node', 'cli', 'auth', 'status'])

        expect(onNotAuthenticated).toHaveBeenCalledWith({
            view: { json: false, ndjson: false },
            flags: {},
        })
        expect(order).toEqual(['onNotAuthenticated'])
        expect(renderText).not.toHaveBeenCalled()
    })

    it('exposes consumer-attached options in flags but strips --json / --ndjson', async () => {
        const { program, parent: auth } = buildProgram('auth')
        const renderText = vi.fn((ctx: { account: Account }) => `Signed in as ${ctx.account.email}`)
        const status = attachStatusCommand<Account>(auth, {
            store: buildStore().store,
            renderText,
        })
        status.option('--full', 'Show extended fields')

        await program.parseAsync(['node', 'cli', 'auth', 'status', '--full'])

        expect(renderText).toHaveBeenCalledWith({
            account,
            view: { json: false, ndjson: false },
            flags: { full: true },
        })
    })

    it('returns the new Command so the consumer can chain', () => {
        const { parent: auth } = buildProgram('auth')
        const status = attachStatusCommand<Account>(auth, {
            store: buildStore().store,
            renderText: () => 'ok',
        })

        expect(status.name()).toBe('status')
    })

    it('threads --user ref to store.active(ref) and strips it from flags', async () => {
        const built = buildStore()
        const { program, renderText } = build({}, built.store)

        await program.parseAsync(['node', 'cli', 'auth', 'status', '--user', 'alan@ingen.com'])

        expect(built.activeSpy).toHaveBeenCalledWith('alan@ingen.com')
        expect(renderText).toHaveBeenCalledWith({
            account,
            view: { json: false, ndjson: false },
            flags: {},
        })
    })

    it('calls store.active(undefined) when --user is absent', async () => {
        const built = buildStore()
        const { program } = build({}, built.store)

        await program.parseAsync(['node', 'cli', 'auth', 'status'])

        expect(built.activeSpy).toHaveBeenCalledWith(undefined)
    })

    it('throws ACCOUNT_NOT_FOUND on explicit --user miss (not NOT_AUTHENTICATED)', async () => {
        const { program } = build({}, buildStore(null).store)

        await expect(
            program.parseAsync(['node', 'cli', 'auth', 'status', '--user', 'ghost']),
        ).rejects.toMatchObject({
            constructor: CliError,
            code: 'ACCOUNT_NOT_FOUND',
        })
    })

    it('surfaces AUTH_STORE_READ_FAILED end-to-end (does not collapse to ACCOUNT_NOT_FOUND)', async () => {
        const thrown = new CliError('AUTH_STORE_READ_FAILED', 'keyring offline')
        const built = buildStore()
        built.activeSpy.mockRejectedValueOnce(thrown)
        const { program } = build({}, built.store)

        // Assert the exact thrown instance bubbles through unchanged — a
        // future refactor that recreates the error with the same code
        // (losing the original `cause` / stack) would still satisfy an
        // `objectContaining({ code })` check.
        await expect(
            program.parseAsync(['node', 'cli', 'auth', 'status', '--user', 'me']),
        ).rejects.toBe(thrown)
    })
})
