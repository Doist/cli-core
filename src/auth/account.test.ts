import { describe, expect, it, vi } from 'vitest'

import { CliError } from '../errors.js'
import { formatJson, formatNdjson } from '../json.js'
import {
    type TestAccount as Account,
    alanGrant,
    buildTokenStore,
    ellieSattler,
} from '../test-support/accounts.js'
import { buildProgram, installConsoleLogSpy } from '../test-support/cli-harness.js'
import {
    type AttachAccountCurrentCommandOptions,
    type AttachAccountListCommandOptions,
    type AttachAccountRemoveCommandOptions,
    type AttachAccountUseCommandOptions,
    attachAccountCurrentCommand,
    attachAccountListCommand,
    attachAccountRemoveCommand,
    attachAccountUseCommand,
} from './account.js'
import type { TokenStore } from './types.js'

const bothAccounts = [
    { account: alanGrant, isDefault: true },
    { account: ellieSattler, isDefault: false },
]

function buildList(
    overrides: Partial<AttachAccountListCommandOptions<Account>> = {},
    store?: TokenStore<Account>,
): {
    program: ReturnType<typeof buildProgram>['program']
    command: ReturnType<typeof buildProgram>['parent']
} {
    const { program, parent } = buildProgram('account')
    const command = attachAccountListCommand<Account>(parent, {
        store: store ?? buildTokenStore().store,
        ...overrides,
    })
    return { program, command }
}

function buildUse(
    overrides: Partial<AttachAccountUseCommandOptions<Account>> = {},
    store?: TokenStore<Account>,
): {
    program: ReturnType<typeof buildProgram>['program']
    command: ReturnType<typeof buildProgram>['parent']
} {
    const { program, parent } = buildProgram('account')
    const command = attachAccountUseCommand<Account>(parent, {
        store: store ?? buildTokenStore().store,
        ...overrides,
    })
    return { program, command }
}

function buildCurrent(
    overrides: Partial<AttachAccountCurrentCommandOptions<Account>> = {},
    store?: TokenStore<Account>,
): {
    program: ReturnType<typeof buildProgram>['program']
    command: ReturnType<typeof buildProgram>['parent']
} {
    const { program, parent } = buildProgram('account')
    const command = attachAccountCurrentCommand<Account>(parent, {
        store: store ?? buildTokenStore().store,
        ...overrides,
    })
    return { program, command }
}

function buildRemove(
    overrides: Partial<AttachAccountRemoveCommandOptions<Account>> = {},
    store?: TokenStore<Account>,
): {
    program: ReturnType<typeof buildProgram>['program']
    command: ReturnType<typeof buildProgram>['parent']
} {
    const { program, parent } = buildProgram('account')
    const command = attachAccountRemoveCommand<Account>(parent, {
        store: store ?? buildTokenStore().store,
        ...overrides,
    })
    return { program, command }
}

describe('attachAccountListCommand', () => {
    const logSpy = installConsoleLogSpy()

    it('renders default human lines with a (default) marker only on the default entry', async () => {
        const { program } = buildList()

        await program.parseAsync(['node', 'cli', 'account', 'list'])

        const emitted = logSpy().mock.calls.map((call: unknown[]) => call[0])
        expect(emitted).toEqual(['Alan Grant (id:1) (default)', 'Ellie Sattler (id:2)'])
    })

    it('emits a custom renderText string', async () => {
        const renderText = vi.fn(() => 'one line')
        const { program } = buildList({ renderText })

        await program.parseAsync(['node', 'cli', 'account', 'list'])

        expect(renderText).toHaveBeenCalledWith({
            accounts: bothAccounts,
            default: '1',
            view: { json: false, ndjson: false },
            flags: {},
        })
        expect(logSpy()).toHaveBeenCalledWith('one line')
    })

    it('emits each line when renderText returns an array', async () => {
        const renderText = vi.fn(() => ['line 1', 'line 2', 'line 3'])
        const { program } = buildList({ renderText })

        await program.parseAsync(['node', 'cli', 'account', 'list'])

        const emitted = logSpy()
            .mock.calls.map((call: unknown[]) => call[0])
            .join('\n')
        expect(emitted).toBe('line 1\nline 2\nline 3')
    })

    it('emits the default envelope under --json', async () => {
        const { program } = buildList()

        await program.parseAsync(['node', 'cli', 'account', 'list', '--json'])

        expect(logSpy()).toHaveBeenCalledWith(
            formatJson({
                accounts: [
                    { account: alanGrant, isDefault: true },
                    { account: ellieSattler, isDefault: false },
                ],
                default: '1',
            }),
        )
    })

    it('invokes renderJson per account under --json and keeps the envelope default', async () => {
        const renderJson = vi.fn(
            ({ account, isDefault }: { account: Account; isDefault: boolean }) => ({
                name: account.label,
                isDefault,
            }),
        )
        const { program } = buildList({ renderJson })

        await program.parseAsync(['node', 'cli', 'account', 'list', '--json'])

        expect(renderJson).toHaveBeenCalledTimes(2)
        expect(renderJson).toHaveBeenNthCalledWith(1, {
            account: alanGrant,
            isDefault: true,
            flags: {},
        })
        expect(renderJson).toHaveBeenNthCalledWith(2, {
            account: ellieSattler,
            isDefault: false,
            flags: {},
        })
        expect(logSpy()).toHaveBeenCalledWith(
            formatJson({
                accounts: [
                    { name: 'Alan Grant', isDefault: true },
                    { name: 'Ellie Sattler', isDefault: false },
                ],
                default: '1',
            }),
        )
    })

    it('streams one object per account under --ndjson with no envelope', async () => {
        const { program } = buildList()

        await program.parseAsync(['node', 'cli', 'account', 'list', '--ndjson'])

        const emitted = logSpy().mock.calls.map((call: unknown[]) => call[0])
        expect(emitted).toEqual([
            formatNdjson([{ account: alanGrant, isDefault: true }]),
            formatNdjson([{ account: ellieSattler, isDefault: false }]),
        ])
    })

    it('shapes each --ndjson line via renderJson, matching the --json accounts entries', async () => {
        const renderJson = vi.fn(
            ({ account, isDefault }: { account: Account; isDefault: boolean }) => ({
                name: account.label,
                isDefault,
            }),
        )
        const { program } = buildList({ renderJson })

        await program.parseAsync(['node', 'cli', 'account', 'list', '--ndjson'])

        expect(renderJson).toHaveBeenNthCalledWith(1, {
            account: alanGrant,
            isDefault: true,
            flags: {},
        })
        expect(renderJson).toHaveBeenNthCalledWith(2, {
            account: ellieSattler,
            isDefault: false,
            flags: {},
        })
        const emitted = logSpy().mock.calls.map((call: unknown[]) => call[0])
        expect(emitted).toEqual([
            formatNdjson([{ name: 'Alan Grant', isDefault: true }]),
            formatNdjson([{ name: 'Ellie Sattler', isDefault: false }]),
        ])
    })

    it('prefers --json over --ndjson when both flags are passed', async () => {
        const { program } = buildList()

        await program.parseAsync(['node', 'cli', 'account', 'list', '--json', '--ndjson'])

        expect(logSpy()).toHaveBeenCalledTimes(1)
        expect(logSpy()).toHaveBeenCalledWith(
            formatJson({
                accounts: [
                    { account: alanGrant, isDefault: true },
                    { account: ellieSattler, isDefault: false },
                ],
                default: '1',
            }),
        )
    })

    it('throws INVALID_TYPE in both machine modes when renderJson is non-serializable', async () => {
        const renderJson = vi.fn(() => undefined)

        for (const mode of ['--json', '--ndjson'] as const) {
            const { program } = buildList({ renderJson })
            await expect(
                program.parseAsync(['node', 'cli', 'account', 'list', mode]),
            ).rejects.toMatchObject({ constructor: CliError, code: 'INVALID_TYPE' })
        }
    })

    it('does not invoke renderJson in human mode', async () => {
        const renderJson = vi.fn(() => ({ x: 1 }))
        const { program } = buildList({ renderJson })

        await program.parseAsync(['node', 'cli', 'account', 'list'])

        expect(renderJson).not.toHaveBeenCalled()
    })

    it('emits an empty envelope under --json when no accounts are stored', async () => {
        const { program } = buildList({}, buildTokenStore({ entries: [] }).store)

        await program.parseAsync(['node', 'cli', 'account', 'list', '--json'])

        expect(logSpy()).toHaveBeenCalledWith(formatJson({ accounts: [], default: null }))
    })

    it('emits nothing under --ndjson when no accounts are stored', async () => {
        const { program } = buildList({}, buildTokenStore({ entries: [] }).store)

        await program.parseAsync(['node', 'cli', 'account', 'list', '--ndjson'])

        expect(logSpy()).not.toHaveBeenCalled()
    })

    it('emits the default empty-state message in human mode when no accounts are stored', async () => {
        const { program } = buildList({}, buildTokenStore({ entries: [] }).store)

        await program.parseAsync(['node', 'cli', 'account', 'list'])

        expect(logSpy()).toHaveBeenCalledWith('No accounts stored.')
    })

    it('reports default null when no entry is marked default', async () => {
        const store = buildTokenStore({
            entries: [
                { account: alanGrant, isDefault: false },
                { account: ellieSattler, isDefault: false },
            ],
        }).store
        const { program } = buildList({}, store)

        await program.parseAsync(['node', 'cli', 'account', 'list', '--json'])

        expect(logSpy()).toHaveBeenCalledWith(
            formatJson({
                accounts: [
                    { account: alanGrant, isDefault: false },
                    { account: ellieSattler, isDefault: false },
                ],
                default: null,
            }),
        )
    })

    it('exposes consumer-attached options in flags but strips --json / --ndjson', async () => {
        const renderText = vi.fn(() => 'ok')
        const { program, command } = buildList({ renderText })
        command.option('--full', 'Show extended fields')

        await program.parseAsync(['node', 'cli', 'account', 'list', '--full'])

        expect(renderText).toHaveBeenCalledWith({
            accounts: bothAccounts,
            default: '1',
            view: { json: false, ndjson: false },
            flags: { full: true },
        })
    })

    it('returns the new Command so the consumer can chain', () => {
        const { command } = buildList()

        expect(command.name()).toBe('list')
    })
})

describe('attachAccountUseCommand', () => {
    const logSpy = installConsoleLogSpy()

    it('calls setDefault and echoes the raw ref in the human success line', async () => {
        const built = buildTokenStore()
        const { program } = buildUse({}, built.store)

        await program.parseAsync(['node', 'cli', 'account', 'use', 'ellie@ingen.com'])

        expect(built.setDefaultSpy).toHaveBeenCalledWith('ellie@ingen.com')
        expect(logSpy()).toHaveBeenCalledWith('✓ Default account set to ellie@ingen.com')
    })

    it('emits the canonical resolved id under --json, not the requested ref', async () => {
        const { program } = buildUse()

        await program.parseAsync(['node', 'cli', 'account', 'use', 'ellie@ingen.com', '--json'])

        expect(logSpy()).toHaveBeenCalledWith(formatJson({ ok: true, default: '2' }))
    })

    it('prefers --json over --ndjson when both flags are passed', async () => {
        const { program } = buildUse()

        await program.parseAsync([
            'node',
            'cli',
            'account',
            'use',
            'ellie@ingen.com',
            '--json',
            '--ndjson',
        ])

        expect(logSpy()).toHaveBeenCalledWith(formatJson({ ok: true, default: '2' }))
    })

    it('does not re-read the store outside --json', async () => {
        const built = buildTokenStore()
        const { program } = buildUse({}, built.store)

        await program.parseAsync(['node', 'cli', 'account', 'use', 'ellie@ingen.com'])

        expect(built.setDefaultSpy).toHaveBeenCalledWith('ellie@ingen.com')
        expect(built.listSpy).not.toHaveBeenCalled()
    })

    it('is silent under --ndjson but still calls setDefault', async () => {
        const built = buildTokenStore()
        const { program } = buildUse({}, built.store)

        await program.parseAsync(['node', 'cli', 'account', 'use', 'ellie@ingen.com', '--ndjson'])

        expect(built.setDefaultSpy).toHaveBeenCalledWith('ellie@ingen.com')
        expect(logSpy()).not.toHaveBeenCalled()
    })

    it('propagates ACCOUNT_NOT_FOUND from setDefault and prints nothing', async () => {
        const built = buildTokenStore()
        const { program } = buildUse({}, built.store)

        // `ghost` matches no stored id/email/label, so the store throws naturally.
        await expect(
            program.parseAsync(['node', 'cli', 'account', 'use', 'ghost']),
        ).rejects.toMatchObject({ constructor: CliError, code: 'ACCOUNT_NOT_FOUND' })
        expect(built.listSpy).not.toHaveBeenCalled()
        expect(logSpy()).not.toHaveBeenCalled()
    })

    it('emits the success line before awaiting onDefaultSet', async () => {
        let releaseHook!: () => void
        const hookGate = new Promise<void>((resolve) => {
            releaseHook = resolve
        })
        const onDefaultSet = vi.fn(() => hookGate)
        const { program } = buildUse({ onDefaultSet })

        const parsed = program
            .parseAsync(['node', 'cli', 'account', 'use', 'ellie@ingen.com'])
            .then(() => 'done')
        await vi.waitFor(() => expect(onDefaultSet).toHaveBeenCalled())

        // Success line is already out, but the command is still parked on the hook.
        expect(logSpy()).toHaveBeenCalledWith('✓ Default account set to ellie@ingen.com')
        expect(onDefaultSet).toHaveBeenCalledWith({
            ref: 'ellie@ingen.com',
            view: { json: false, ndjson: false },
            flags: {},
        })
        expect(await Promise.race([parsed, Promise.resolve('pending')])).toBe('pending')

        releaseHook()
        expect(await parsed).toBe('done')
    })

    it('exposes consumer-attached options in flags but strips --json / --ndjson', async () => {
        const onDefaultSet = vi.fn()
        const { program, command } = buildUse({ onDefaultSet })
        command.option('--full', 'Extra')

        await program.parseAsync(['node', 'cli', 'account', 'use', 'ellie@ingen.com', '--full'])

        expect(onDefaultSet).toHaveBeenCalledWith({
            ref: 'ellie@ingen.com',
            view: { json: false, ndjson: false },
            flags: { full: true },
        })
    })

    it('returns the new Command so the consumer can chain', () => {
        const { command } = buildUse()

        expect(command.name()).toBe('use')
    })
})

describe('attachAccountCurrentCommand', () => {
    const logSpy = installConsoleLogSpy()

    it('renders the default human line with a (default) marker for the active account', async () => {
        const { program } = buildCurrent()

        await program.parseAsync(['node', 'cli', 'account', 'current'])

        expect(logSpy()).toHaveBeenCalledWith('Alan Grant (id:1) (default)')
    })

    it('omits the marker when the active account is not the default', async () => {
        const store: TokenStore<Account> = {
            active: vi.fn(async () => ({ token: 't', account: alanGrant })),
            set: vi.fn(),
            clear: vi.fn(),
            list: vi.fn(async () => [
                { account: alanGrant, isDefault: false },
                { account: ellieSattler, isDefault: true },
            ]),
            setDefault: vi.fn(),
        }
        const { program } = buildCurrent({}, store)

        await program.parseAsync(['node', 'cli', 'account', 'current'])

        expect(logSpy()).toHaveBeenCalledWith('Alan Grant (id:1)')
    })

    it('passes account + isDefault to a custom renderText', async () => {
        const renderText = vi.fn(() => 'custom line')
        const { program } = buildCurrent({ renderText })

        await program.parseAsync(['node', 'cli', 'account', 'current'])

        expect(renderText).toHaveBeenCalledWith({
            account: alanGrant,
            isDefault: true,
            view: { json: false, ndjson: false },
            flags: {},
        })
        expect(logSpy()).toHaveBeenCalledWith('custom line')
    })

    it('emits the default { account, isDefault } payload under --json', async () => {
        const { program } = buildCurrent()

        await program.parseAsync(['node', 'cli', 'account', 'current', '--json'])

        expect(logSpy()).toHaveBeenCalledWith(formatJson({ account: alanGrant, isDefault: true }))
    })

    it('shapes the --json payload via renderJson', async () => {
        const renderJson = vi.fn(({ account }: { account: Account }) => ({ email: account.email }))
        const { program } = buildCurrent({ renderJson })

        await program.parseAsync(['node', 'cli', 'account', 'current', '--json'])

        expect(renderJson).toHaveBeenCalledWith({ account: alanGrant, isDefault: true, flags: {} })
        expect(logSpy()).toHaveBeenCalledWith(formatJson({ email: 'alan@ingen.com' }))
    })

    it('emits a single payload object under --ndjson', async () => {
        const { program } = buildCurrent()

        await program.parseAsync(['node', 'cli', 'account', 'current', '--ndjson'])

        expect(logSpy()).toHaveBeenCalledWith(
            formatNdjson([{ account: alanGrant, isDefault: true }]),
        )
    })

    it('prefers --json over --ndjson when both flags are passed', async () => {
        const { program } = buildCurrent()

        await program.parseAsync(['node', 'cli', 'account', 'current', '--json', '--ndjson'])

        expect(logSpy()).toHaveBeenCalledOnce()
        expect(logSpy()).toHaveBeenCalledWith(formatJson({ account: alanGrant, isDefault: true }))
    })

    // Covers both non-serializable shapes: a top-level `undefined`
    // (`JSON.stringify` returns `undefined`) and a value that makes
    // `JSON.stringify` *throw* (a `BigInt`). Both must surface as INVALID_TYPE
    // in either machine mode rather than leaking a raw TypeError.
    it.each([
        ['top-level undefined', () => undefined],
        ['a throwing BigInt', () => ({ count: 1n })],
    ])('throws INVALID_TYPE in both machine modes for %s', async (_label, renderJson) => {
        for (const mode of ['--json', '--ndjson'] as const) {
            const { program } = buildCurrent({ renderJson })
            await expect(
                program.parseAsync(['node', 'cli', 'account', 'current', mode]),
            ).rejects.toMatchObject({ constructor: CliError, code: 'INVALID_TYPE' })
        }
    })

    it('invokes onNotAuthenticated when nothing is active', async () => {
        const onNotAuthenticated = vi.fn()
        const { program } = buildCurrent(
            { onNotAuthenticated },
            buildTokenStore({ entries: [] }).store,
        )

        await program.parseAsync(['node', 'cli', 'account', 'current'])

        expect(onNotAuthenticated).toHaveBeenCalledWith({
            view: { json: false, ndjson: false },
            flags: {},
        })
        expect(logSpy()).not.toHaveBeenCalled()
    })

    it('throws NOT_AUTHENTICATED when nothing is active and no hook is supplied', async () => {
        const { program } = buildCurrent({}, buildTokenStore({ entries: [] }).store)

        await expect(
            program.parseAsync(['node', 'cli', 'account', 'current']),
        ).rejects.toMatchObject({ constructor: CliError, code: 'NOT_AUTHENTICATED' })
    })

    it('prefers store.activeAccount over active() + list() when implemented', async () => {
        const built = buildTokenStore()
        built.store.activeAccount = vi.fn(async () => ({ account: ellieSattler, isDefault: false }))
        const { program } = buildCurrent({}, built.store)

        await program.parseAsync(['node', 'cli', 'account', 'current'])

        expect(built.store.activeAccount).toHaveBeenCalledOnce()
        expect(built.activeSpy).not.toHaveBeenCalled()
        expect(built.listSpy).not.toHaveBeenCalled()
        expect(logSpy()).toHaveBeenCalledWith('Ellie Sattler (id:2)')
    })

    it('returns the new Command so the consumer can chain', () => {
        const { command } = buildCurrent()

        expect(command.name()).toBe('current')
    })
})

describe('attachAccountRemoveCommand', () => {
    const logSpy = installConsoleLogSpy()

    it('removes the matched account by ref and marks it as the former default', async () => {
        const built = buildTokenStore()
        const { program } = buildRemove({}, built.store)

        // Invoked by email; the store matches + clears it token-free.
        await program.parseAsync(['node', 'cli', 'account', 'remove', 'alan@ingen.com'])

        expect(built.clearSpy).toHaveBeenCalledWith('alan@ingen.com')
        expect(await built.store.list()).toEqual([{ account: ellieSattler, isDefault: false }])
        expect(logSpy()).toHaveBeenCalledOnce()
        expect(logSpy()).toHaveBeenCalledWith('✓ Removed Alan Grant (default)')
    })

    it('omits the (default) marker when the removed account was not the default', async () => {
        const built = buildTokenStore()
        const { program } = buildRemove({}, built.store)

        await program.parseAsync(['node', 'cli', 'account', 'remove', 'ellie@ingen.com'])

        expect(logSpy()).toHaveBeenCalledOnce()
        expect(logSpy()).toHaveBeenCalledWith('✓ Removed Ellie Sattler')
    })

    it('throws ACCOUNT_NOT_FOUND and removes nothing when the ref misses', async () => {
        const built = buildTokenStore()
        const { program } = buildRemove({}, built.store)

        await expect(
            program.parseAsync(['node', 'cli', 'account', 'remove', 'ghost']),
        ).rejects.toMatchObject({ constructor: CliError, code: 'ACCOUNT_NOT_FOUND' })
        expect(await built.store.list()).toHaveLength(2)
    })

    it('removes an account whose token is unreadable, never touching active()', async () => {
        const built = buildTokenStore()
        // A broken keyring entry: `active()` would throw AUTH_STORE_READ_FAILED,
        // but `remove` must still clear it. If the attacher called active() this
        // would surface that error instead of removing the record.
        built.store.active = vi.fn(async () => {
            throw new CliError('AUTH_STORE_READ_FAILED', 'keyring offline')
        })
        const { program } = buildRemove({}, built.store)

        await program.parseAsync(['node', 'cli', 'account', 'remove', 'alan@ingen.com'])

        expect(built.store.active).not.toHaveBeenCalled()
        expect(await built.store.list()).toEqual([{ account: ellieSattler, isDefault: false }])
        expect(logSpy()).toHaveBeenCalledWith('✓ Removed Alan Grant (default)')
    })

    it('emits { ok, removed } with the canonical id under --json', async () => {
        const { program } = buildRemove()

        await program.parseAsync(['node', 'cli', 'account', 'remove', 'ellie@ingen.com', '--json'])

        expect(logSpy()).toHaveBeenCalledWith(formatJson({ ok: true, removed: '2' }))
    })

    it('prefers --json over --ndjson when both flags are passed', async () => {
        const { program } = buildRemove()

        await program.parseAsync([
            'node',
            'cli',
            'account',
            'remove',
            'ellie@ingen.com',
            '--json',
            '--ndjson',
        ])

        expect(logSpy()).toHaveBeenCalledOnce()
        expect(logSpy()).toHaveBeenCalledWith(formatJson({ ok: true, removed: '2' }))
    })

    it('is silent under --ndjson but still clears and runs onRemoved', async () => {
        const built = buildTokenStore()
        const onRemoved = vi.fn()
        const { program } = buildRemove({ onRemoved }, built.store)

        await program.parseAsync([
            'node',
            'cli',
            'account',
            'remove',
            'ellie@ingen.com',
            '--ndjson',
        ])

        expect(await built.store.list()).toEqual([{ account: alanGrant, isDefault: true }])
        expect(logSpy()).not.toHaveBeenCalled()
        expect(onRemoved).toHaveBeenCalledOnce()
    })

    it('passes the removed account + wasDefault to renderText and onRemoved', async () => {
        const renderText = vi.fn(() => 'gone')
        const onRemoved = vi.fn()
        const { program } = buildRemove({ renderText, onRemoved })

        await program.parseAsync(['node', 'cli', 'account', 'remove', 'alan@ingen.com'])

        const expectedCtx = {
            account: alanGrant,
            ref: 'alan@ingen.com',
            wasDefault: true,
            view: { json: false, ndjson: false },
            flags: {},
        }
        expect(renderText).toHaveBeenCalledWith(expectedCtx)
        expect(onRemoved).toHaveBeenCalledWith(expectedCtx)
        expect(logSpy()).toHaveBeenCalledWith('gone')
    })

    it('emits the success line before awaiting onRemoved', async () => {
        let releaseHook!: () => void
        const hookGate = new Promise<void>((resolve) => {
            releaseHook = resolve
        })
        const onRemoved = vi.fn(() => hookGate)
        const { program } = buildRemove({ onRemoved })

        const parsed = program
            .parseAsync(['node', 'cli', 'account', 'remove', 'ellie@ingen.com'])
            .then(() => 'done')
        await vi.waitFor(() => expect(onRemoved).toHaveBeenCalled())

        // Success line is already out, but the command is still parked on the hook.
        expect(logSpy()).toHaveBeenCalledWith('✓ Removed Ellie Sattler')
        expect(await Promise.race([parsed, Promise.resolve('pending')])).toBe('pending')

        releaseHook()
        expect(await parsed).toBe('done')
    })

    it('returns the new Command so the consumer can chain', () => {
        const { command } = buildRemove()

        expect(command.name()).toBe('remove')
    })
})
