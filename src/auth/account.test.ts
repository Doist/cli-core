import { Command } from 'commander'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { CliError } from '../errors.js'
import { formatJson, formatNdjson } from '../json.js'
import {
    type AttachAccountListCommandOptions,
    type AttachAccountUseCommandOptions,
    attachAccountListCommand,
    attachAccountUseCommand,
} from './account.js'
import type { TokenStore } from './types.js'

type Account = { id: string; label?: string; email: string }

const a1: Account = { id: '1', label: 'Alice', email: 'alice@b' }
const a2: Account = { id: '2', label: 'Bob', email: 'bob@b' }

type Entry = { account: Account; isDefault: boolean }
const bothAccounts: Entry[] = [
    { account: a1, isDefault: true },
    { account: a2, isDefault: false },
]

function buildStore(entries: Entry[] = bothAccounts): {
    store: TokenStore<Account>
    listSpy: ReturnType<typeof vi.fn>
    setDefaultSpy: ReturnType<typeof vi.fn>
} {
    const listSpy = vi.fn(async () => entries)
    const setDefaultSpy = vi.fn(async () => {})
    const store: TokenStore<Account> = {
        active: vi.fn(async () => null),
        set: vi.fn(),
        clear: vi.fn(),
        list: listSpy,
        setDefault: setDefaultSpy,
    }
    return { store, listSpy, setDefaultSpy }
}

function buildList(
    overrides: Partial<AttachAccountListCommandOptions<Account>> = {},
    store?: TokenStore<Account>,
): { program: Command; command: Command } {
    const resolvedStore = store ?? buildStore().store
    const program = new Command()
    program.exitOverride()
    const account = program.command('account')
    const command = attachAccountListCommand<Account>(account, {
        store: resolvedStore,
        ...overrides,
    })
    return { program, command }
}

function buildUse(
    overrides: Partial<AttachAccountUseCommandOptions<Account>> = {},
    store?: TokenStore<Account>,
): { program: Command; command: Command } {
    const resolvedStore = store ?? buildStore().store
    const program = new Command()
    program.exitOverride()
    const account = program.command('account')
    const command = attachAccountUseCommand<Account>(account, {
        store: resolvedStore,
        ...overrides,
    })
    return { program, command }
}

describe('attachAccountListCommand', () => {
    let logSpy: ReturnType<typeof vi.spyOn>

    beforeEach(() => {
        logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    })

    afterEach(() => {
        logSpy.mockRestore()
    })

    it('renders default human lines with a (default) marker only on the default entry', async () => {
        const { program } = buildList()

        await program.parseAsync(['node', 'cli', 'account', 'list'])

        const emitted = logSpy.mock.calls.map((call: unknown[]) => call[0])
        expect(emitted).toEqual(['Alice (id:1) (default)', 'Bob (id:2)'])
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
        expect(logSpy).toHaveBeenCalledWith('one line')
    })

    it('emits each line when renderText returns an array', async () => {
        const renderText = vi.fn(() => ['line 1', 'line 2', 'line 3'])
        const { program } = buildList({ renderText })

        await program.parseAsync(['node', 'cli', 'account', 'list'])

        const emitted = logSpy.mock.calls.map((call: unknown[]) => call[0]).join('\n')
        expect(emitted).toBe('line 1\nline 2\nline 3')
    })

    it('emits the default envelope under --json', async () => {
        const { program } = buildList()

        await program.parseAsync(['node', 'cli', 'account', 'list', '--json'])

        expect(logSpy).toHaveBeenCalledWith(
            formatJson({
                accounts: [
                    { account: a1, isDefault: true },
                    { account: a2, isDefault: false },
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
        expect(renderJson).toHaveBeenNthCalledWith(1, { account: a1, isDefault: true, flags: {} })
        expect(renderJson).toHaveBeenNthCalledWith(2, { account: a2, isDefault: false, flags: {} })
        expect(logSpy).toHaveBeenCalledWith(
            formatJson({
                accounts: [
                    { name: 'Alice', isDefault: true },
                    { name: 'Bob', isDefault: false },
                ],
                default: '1',
            }),
        )
    })

    it('streams one object per account under --ndjson with no envelope', async () => {
        const { program } = buildList()

        await program.parseAsync(['node', 'cli', 'account', 'list', '--ndjson'])

        expect(logSpy).toHaveBeenCalledWith(
            formatNdjson([
                { account: a1, isDefault: true },
                { account: a2, isDefault: false },
            ]),
        )
    })

    it('does not invoke renderJson in human mode', async () => {
        const renderJson = vi.fn(() => ({ x: 1 }))
        const { program } = buildList({ renderJson })

        await program.parseAsync(['node', 'cli', 'account', 'list'])

        expect(renderJson).not.toHaveBeenCalled()
    })

    it('emits an empty envelope under --json when no accounts are stored', async () => {
        const { program } = buildList({}, buildStore([]).store)

        await program.parseAsync(['node', 'cli', 'account', 'list', '--json'])

        expect(logSpy).toHaveBeenCalledWith(formatJson({ accounts: [], default: null }))
    })

    it('emits nothing under --ndjson when no accounts are stored', async () => {
        const { program } = buildList({}, buildStore([]).store)

        await program.parseAsync(['node', 'cli', 'account', 'list', '--ndjson'])

        expect(logSpy).not.toHaveBeenCalled()
    })

    it('emits the default empty-state message in human mode when no accounts are stored', async () => {
        const { program } = buildList({}, buildStore([]).store)

        await program.parseAsync(['node', 'cli', 'account', 'list'])

        expect(logSpy).toHaveBeenCalledWith('No accounts stored.')
    })

    it('reports default null when no entry is marked default', async () => {
        const store = buildStore([
            { account: a1, isDefault: false },
            { account: a2, isDefault: false },
        ]).store
        const { program } = buildList({}, store)

        await program.parseAsync(['node', 'cli', 'account', 'list', '--json'])

        expect(logSpy).toHaveBeenCalledWith(
            formatJson({
                accounts: [
                    { account: a1, isDefault: false },
                    { account: a2, isDefault: false },
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
    let logSpy: ReturnType<typeof vi.spyOn>

    beforeEach(() => {
        logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    })

    afterEach(() => {
        logSpy.mockRestore()
    })

    it('calls setDefault and prints the success line in human mode', async () => {
        const built = buildStore()
        const { program } = buildUse({}, built.store)

        await program.parseAsync(['node', 'cli', 'account', 'use', 'alice@b'])

        expect(built.setDefaultSpy).toHaveBeenCalledWith('alice@b')
        expect(logSpy).toHaveBeenCalledWith('✓ Default account set to alice@b')
    })

    it('emits the success envelope under --json', async () => {
        const { program } = buildUse()

        await program.parseAsync(['node', 'cli', 'account', 'use', 'alice@b', '--json'])

        expect(logSpy).toHaveBeenCalledWith(formatJson({ ok: true, default: 'alice@b' }))
    })

    it('is silent under --ndjson but still calls setDefault', async () => {
        const built = buildStore()
        const { program } = buildUse({}, built.store)

        await program.parseAsync(['node', 'cli', 'account', 'use', 'alice@b', '--ndjson'])

        expect(built.setDefaultSpy).toHaveBeenCalledWith('alice@b')
        expect(logSpy).not.toHaveBeenCalled()
    })

    it('echoes the raw user-supplied ref, not a resolved id', async () => {
        const { program } = buildUse()

        await program.parseAsync(['node', 'cli', 'account', 'use', 'alice@b', '--json'])

        expect(logSpy).toHaveBeenCalledWith(formatJson({ ok: true, default: 'alice@b' }))
    })

    it('propagates ACCOUNT_NOT_FOUND from setDefault and prints nothing', async () => {
        const thrown = new CliError('ACCOUNT_NOT_FOUND', 'No stored account matches "ghost".')
        const built = buildStore()
        built.setDefaultSpy.mockRejectedValueOnce(thrown)
        const { program } = buildUse({}, built.store)

        await expect(program.parseAsync(['node', 'cli', 'account', 'use', 'ghost'])).rejects.toBe(
            thrown,
        )
        expect(logSpy).not.toHaveBeenCalled()
    })

    it('awaits onDefaultSet after the success line', async () => {
        const order: string[] = []
        const built = buildStore()
        built.setDefaultSpy.mockImplementationOnce(async () => {
            order.push('setDefault')
        })
        const onDefaultSet = vi.fn(async () => {
            await Promise.resolve()
            order.push('onDefaultSet')
        })
        const { program } = buildUse({ onDefaultSet }, built.store)

        await program.parseAsync(['node', 'cli', 'account', 'use', 'alice@b'])

        expect(onDefaultSet).toHaveBeenCalledWith({
            ref: 'alice@b',
            view: { json: false, ndjson: false },
            flags: {},
        })
        expect(order).toEqual(['setDefault', 'onDefaultSet'])
    })

    it('exposes consumer-attached options in flags but strips --json / --ndjson', async () => {
        const onDefaultSet = vi.fn()
        const { program, command } = buildUse({ onDefaultSet })
        command.option('--full', 'Extra')

        await program.parseAsync(['node', 'cli', 'account', 'use', 'alice@b', '--full'])

        expect(onDefaultSet).toHaveBeenCalledWith({
            ref: 'alice@b',
            view: { json: false, ndjson: false },
            flags: { full: true },
        })
    })

    it('returns the new Command so the consumer can chain', () => {
        const { command } = buildUse()

        expect(command.name()).toBe('use')
    })
})
