import { Command } from 'commander'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { CliError } from '../errors.js'
import { formatJson, formatNdjson } from '../json.js'
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

type Account = { id: string; label?: string; email: string }

const a1: Account = { id: '1', label: 'Alice', email: 'alice@b' }
const a2: Account = { id: '2', label: 'Bob', email: 'bob@b' }

type Entry = { account: Account; isDefault: boolean }
const bothAccounts: Entry[] = [
    { account: a1, isDefault: true },
    { account: a2, isDefault: false },
]

function matches(entry: Entry, ref: string): boolean {
    return entry.account.id === ref || entry.account.email === ref || entry.account.label === ref
}

// A store that models multi-account state: `setDefault(ref)` matches by
// id/email/label and re-points the default marker, so a follow-up `list()`
// reflects the change (exercises `use`'s canonical-id re-read).
function buildStore(initial: Entry[] = bothAccounts): {
    store: TokenStore<Account>
    listSpy: ReturnType<typeof vi.fn>
    setDefaultSpy: ReturnType<typeof vi.fn>
    activeSpy: ReturnType<typeof vi.fn>
    clearSpy: ReturnType<typeof vi.fn>
} {
    const entries = initial.map((entry) => ({ ...entry }))
    const listSpy = vi.fn(async () =>
        entries.map((entry) => ({ account: entry.account, isDefault: entry.isDefault })),
    )
    const setDefaultSpy = vi.fn(async (ref: string) => {
        const target = entries.find((entry) => matches(entry, ref))
        if (!target) throw new CliError('ACCOUNT_NOT_FOUND', `No stored account matches "${ref}".`)
        for (const entry of entries) entry.isDefault = entry === target
    })
    // No ref → the default entry (selector-less `current`); a ref → match by
    // id/email/label. Returns null on miss so the attachers can translate it.
    const activeSpy = vi.fn(async (ref?: string) => {
        const target =
            ref === undefined
                ? entries.find((entry) => entry.isDefault)
                : entries.find((entry) => matches(entry, ref))
        return target ? { token: `token-${target.account.id}`, account: target.account } : null
    })
    // Token-free removal: match by id/email/label (or the default when no ref)
    // and drop the entry, so a follow-up `list()` reflects the removal — this
    // is what `attachAccountRemoveCommand` diffs against.
    const clearSpy = vi.fn(async (ref?: string) => {
        const idx = entries.findIndex((entry) =>
            ref === undefined ? entry.isDefault : matches(entry, ref),
        )
        if (idx !== -1) entries.splice(idx, 1)
    })
    const store: TokenStore<Account> = {
        active: activeSpy,
        set: vi.fn(),
        clear: clearSpy,
        list: listSpy,
        setDefault: setDefaultSpy,
    }
    return { store, listSpy, setDefaultSpy, activeSpy, clearSpy }
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

function buildCurrent(
    overrides: Partial<AttachAccountCurrentCommandOptions<Account>> = {},
    store?: TokenStore<Account>,
): { program: Command; command: Command } {
    const resolvedStore = store ?? buildStore().store
    const program = new Command()
    program.exitOverride()
    const account = program.command('account')
    const command = attachAccountCurrentCommand<Account>(account, {
        store: resolvedStore,
        ...overrides,
    })
    return { program, command }
}

function buildRemove(
    overrides: Partial<AttachAccountRemoveCommandOptions<Account>> = {},
    store?: TokenStore<Account>,
): { program: Command; command: Command } {
    const resolvedStore = store ?? buildStore().store
    const program = new Command()
    program.exitOverride()
    const account = program.command('account')
    const command = attachAccountRemoveCommand<Account>(account, {
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

        const emitted = logSpy.mock.calls.map((call: unknown[]) => call[0])
        expect(emitted).toEqual([
            formatNdjson([{ account: a1, isDefault: true }]),
            formatNdjson([{ account: a2, isDefault: false }]),
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

        expect(renderJson).toHaveBeenNthCalledWith(1, { account: a1, isDefault: true, flags: {} })
        expect(renderJson).toHaveBeenNthCalledWith(2, { account: a2, isDefault: false, flags: {} })
        const emitted = logSpy.mock.calls.map((call: unknown[]) => call[0])
        expect(emitted).toEqual([
            formatNdjson([{ name: 'Alice', isDefault: true }]),
            formatNdjson([{ name: 'Bob', isDefault: false }]),
        ])
    })

    it('prefers --json over --ndjson when both flags are passed', async () => {
        const { program } = buildList()

        await program.parseAsync(['node', 'cli', 'account', 'list', '--json', '--ndjson'])

        expect(logSpy).toHaveBeenCalledTimes(1)
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

    it('calls setDefault and echoes the raw ref in the human success line', async () => {
        const built = buildStore()
        const { program } = buildUse({}, built.store)

        await program.parseAsync(['node', 'cli', 'account', 'use', 'bob@b'])

        expect(built.setDefaultSpy).toHaveBeenCalledWith('bob@b')
        expect(logSpy).toHaveBeenCalledWith('✓ Default account set to bob@b')
    })

    it('emits the canonical resolved id under --json, not the requested ref', async () => {
        const { program } = buildUse()

        await program.parseAsync(['node', 'cli', 'account', 'use', 'bob@b', '--json'])

        expect(logSpy).toHaveBeenCalledWith(formatJson({ ok: true, default: '2' }))
    })

    it('prefers --json over --ndjson when both flags are passed', async () => {
        const { program } = buildUse()

        await program.parseAsync(['node', 'cli', 'account', 'use', 'bob@b', '--json', '--ndjson'])

        expect(logSpy).toHaveBeenCalledWith(formatJson({ ok: true, default: '2' }))
    })

    it('does not re-read the store outside --json', async () => {
        const built = buildStore()
        const { program } = buildUse({}, built.store)

        await program.parseAsync(['node', 'cli', 'account', 'use', 'bob@b'])

        expect(built.setDefaultSpy).toHaveBeenCalledWith('bob@b')
        expect(built.listSpy).not.toHaveBeenCalled()
    })

    it('is silent under --ndjson but still calls setDefault', async () => {
        const built = buildStore()
        const { program } = buildUse({}, built.store)

        await program.parseAsync(['node', 'cli', 'account', 'use', 'bob@b', '--ndjson'])

        expect(built.setDefaultSpy).toHaveBeenCalledWith('bob@b')
        expect(logSpy).not.toHaveBeenCalled()
    })

    it('propagates ACCOUNT_NOT_FOUND from setDefault and prints nothing', async () => {
        const built = buildStore()
        const { program } = buildUse({}, built.store)

        // `ghost` matches no stored id/email/label, so the store throws naturally.
        await expect(
            program.parseAsync(['node', 'cli', 'account', 'use', 'ghost']),
        ).rejects.toMatchObject({ constructor: CliError, code: 'ACCOUNT_NOT_FOUND' })
        expect(built.listSpy).not.toHaveBeenCalled()
        expect(logSpy).not.toHaveBeenCalled()
    })

    it('emits the success line before awaiting onDefaultSet', async () => {
        let releaseHook!: () => void
        const hookGate = new Promise<void>((resolve) => {
            releaseHook = resolve
        })
        const onDefaultSet = vi.fn(() => hookGate)
        const { program } = buildUse({ onDefaultSet })

        const parsed = program
            .parseAsync(['node', 'cli', 'account', 'use', 'bob@b'])
            .then(() => 'done')
        await vi.waitFor(() => expect(onDefaultSet).toHaveBeenCalled())

        // Success line is already out, but the command is still parked on the hook.
        expect(logSpy).toHaveBeenCalledWith('✓ Default account set to bob@b')
        expect(onDefaultSet).toHaveBeenCalledWith({
            ref: 'bob@b',
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

        await program.parseAsync(['node', 'cli', 'account', 'use', 'bob@b', '--full'])

        expect(onDefaultSet).toHaveBeenCalledWith({
            ref: 'bob@b',
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
    let logSpy: ReturnType<typeof vi.spyOn>

    beforeEach(() => {
        logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    })

    afterEach(() => {
        logSpy.mockRestore()
    })

    it('renders the default human line with a (default) marker for the active account', async () => {
        const { program } = buildCurrent()

        await program.parseAsync(['node', 'cli', 'account', 'current'])

        expect(logSpy).toHaveBeenCalledWith('Alice (id:1) (default)')
    })

    it('omits the marker when the active account is not the default', async () => {
        const store: TokenStore<Account> = {
            active: vi.fn(async () => ({ token: 't', account: a1 })),
            set: vi.fn(),
            clear: vi.fn(),
            list: vi.fn(async () => [
                { account: a1, isDefault: false },
                { account: a2, isDefault: true },
            ]),
            setDefault: vi.fn(),
        }
        const { program } = buildCurrent({}, store)

        await program.parseAsync(['node', 'cli', 'account', 'current'])

        expect(logSpy).toHaveBeenCalledWith('Alice (id:1)')
    })

    it('passes account + isDefault to a custom renderText', async () => {
        const renderText = vi.fn(() => 'custom line')
        const { program } = buildCurrent({ renderText })

        await program.parseAsync(['node', 'cli', 'account', 'current'])

        expect(renderText).toHaveBeenCalledWith({
            account: a1,
            isDefault: true,
            view: { json: false, ndjson: false },
            flags: {},
        })
        expect(logSpy).toHaveBeenCalledWith('custom line')
    })

    it('emits the default { account, isDefault } payload under --json', async () => {
        const { program } = buildCurrent()

        await program.parseAsync(['node', 'cli', 'account', 'current', '--json'])

        expect(logSpy).toHaveBeenCalledWith(formatJson({ account: a1, isDefault: true }))
    })

    it('shapes the --json payload via renderJson', async () => {
        const renderJson = vi.fn(({ account }: { account: Account }) => ({ email: account.email }))
        const { program } = buildCurrent({ renderJson })

        await program.parseAsync(['node', 'cli', 'account', 'current', '--json'])

        expect(renderJson).toHaveBeenCalledWith({ account: a1, isDefault: true, flags: {} })
        expect(logSpy).toHaveBeenCalledWith(formatJson({ email: 'alice@b' }))
    })

    it('emits a single payload object under --ndjson', async () => {
        const { program } = buildCurrent()

        await program.parseAsync(['node', 'cli', 'account', 'current', '--ndjson'])

        expect(logSpy).toHaveBeenCalledWith(formatNdjson([{ account: a1, isDefault: true }]))
    })

    it('prefers --json over --ndjson when both flags are passed', async () => {
        const { program } = buildCurrent()

        await program.parseAsync(['node', 'cli', 'account', 'current', '--json', '--ndjson'])

        expect(logSpy).toHaveBeenCalledOnce()
        expect(logSpy).toHaveBeenCalledWith(formatJson({ account: a1, isDefault: true }))
    })

    it('throws INVALID_TYPE in both machine modes when renderJson is non-serializable', async () => {
        const renderJson = vi.fn(() => undefined)

        for (const mode of ['--json', '--ndjson'] as const) {
            const { program } = buildCurrent({ renderJson })
            await expect(
                program.parseAsync(['node', 'cli', 'account', 'current', mode]),
            ).rejects.toMatchObject({ constructor: CliError, code: 'INVALID_TYPE' })
        }
    })

    it('invokes onNotAuthenticated when nothing is active', async () => {
        const onNotAuthenticated = vi.fn()
        const { program } = buildCurrent({ onNotAuthenticated }, buildStore([]).store)

        await program.parseAsync(['node', 'cli', 'account', 'current'])

        expect(onNotAuthenticated).toHaveBeenCalledWith({
            view: { json: false, ndjson: false },
            flags: {},
        })
        expect(logSpy).not.toHaveBeenCalled()
    })

    it('throws NOT_AUTHENTICATED when nothing is active and no hook is supplied', async () => {
        const { program } = buildCurrent({}, buildStore([]).store)

        await expect(
            program.parseAsync(['node', 'cli', 'account', 'current']),
        ).rejects.toMatchObject({ constructor: CliError, code: 'NOT_AUTHENTICATED' })
    })

    it('returns the new Command so the consumer can chain', () => {
        const { command } = buildCurrent()

        expect(command.name()).toBe('current')
    })
})

describe('attachAccountRemoveCommand', () => {
    let logSpy: ReturnType<typeof vi.spyOn>

    beforeEach(() => {
        logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    })

    afterEach(() => {
        logSpy.mockRestore()
    })

    it('removes the matched account by ref and flags the cleared default', async () => {
        const built = buildStore()
        const { program } = buildRemove({}, built.store)

        // Invoked by email; the store matches + clears it token-free.
        await program.parseAsync(['node', 'cli', 'account', 'remove', 'alice@b'])

        expect(built.clearSpy).toHaveBeenCalledWith('alice@b')
        expect(await built.store.list()).toEqual([{ account: a2, isDefault: false }])
        const emitted = logSpy.mock.calls.map((call: unknown[]) => call[0])
        expect(emitted).toEqual(['✓ Removed Alice', 'Cleared default account.'])
    })

    it('omits the cleared-default line when the removed account was not the default', async () => {
        const built = buildStore()
        const { program } = buildRemove({}, built.store)

        await program.parseAsync(['node', 'cli', 'account', 'remove', 'bob@b'])

        expect(logSpy).toHaveBeenCalledOnce()
        expect(logSpy).toHaveBeenCalledWith('✓ Removed Bob')
    })

    it('throws ACCOUNT_NOT_FOUND and removes nothing when the ref misses', async () => {
        const built = buildStore()
        const { program } = buildRemove({}, built.store)

        await expect(
            program.parseAsync(['node', 'cli', 'account', 'remove', 'ghost']),
        ).rejects.toMatchObject({ constructor: CliError, code: 'ACCOUNT_NOT_FOUND' })
        expect(await built.store.list()).toHaveLength(2)
    })

    it('removes an account whose token is unreadable, never touching active()', async () => {
        const built = buildStore()
        // A broken keyring entry: `active()` would throw AUTH_STORE_READ_FAILED,
        // but `remove` must still clear it. If the attacher called active() this
        // would surface that error instead of removing the record.
        built.store.active = vi.fn(async () => {
            throw new CliError('AUTH_STORE_READ_FAILED', 'keyring offline')
        })
        const { program } = buildRemove({}, built.store)

        await program.parseAsync(['node', 'cli', 'account', 'remove', 'alice@b'])

        expect(built.store.active).not.toHaveBeenCalled()
        expect(await built.store.list()).toEqual([{ account: a2, isDefault: false }])
        expect(logSpy).toHaveBeenCalledWith('✓ Removed Alice')
    })

    it('emits { ok, removed } with the canonical id under --json', async () => {
        const { program } = buildRemove()

        await program.parseAsync(['node', 'cli', 'account', 'remove', 'bob@b', '--json'])

        expect(logSpy).toHaveBeenCalledWith(formatJson({ ok: true, removed: '2' }))
    })

    it('prefers --json over --ndjson when both flags are passed', async () => {
        const { program } = buildRemove()

        await program.parseAsync([
            'node',
            'cli',
            'account',
            'remove',
            'bob@b',
            '--json',
            '--ndjson',
        ])

        expect(logSpy).toHaveBeenCalledOnce()
        expect(logSpy).toHaveBeenCalledWith(formatJson({ ok: true, removed: '2' }))
    })

    it('is silent under --ndjson but still clears and runs onRemoved', async () => {
        const built = buildStore()
        const onRemoved = vi.fn()
        const { program } = buildRemove({ onRemoved }, built.store)

        await program.parseAsync(['node', 'cli', 'account', 'remove', 'bob@b', '--ndjson'])

        expect(await built.store.list()).toEqual([{ account: a1, isDefault: true }])
        expect(logSpy).not.toHaveBeenCalled()
        expect(onRemoved).toHaveBeenCalledOnce()
    })

    it('passes the removed account + wasDefault to renderText and onRemoved', async () => {
        const renderText = vi.fn(() => 'gone')
        const onRemoved = vi.fn()
        const { program } = buildRemove({ renderText, onRemoved })

        await program.parseAsync(['node', 'cli', 'account', 'remove', 'alice@b'])

        const expectedCtx = {
            account: a1,
            ref: 'alice@b',
            wasDefault: true,
            view: { json: false, ndjson: false },
            flags: {},
        }
        expect(renderText).toHaveBeenCalledWith(expectedCtx)
        expect(onRemoved).toHaveBeenCalledWith(expectedCtx)
        expect(logSpy).toHaveBeenCalledWith('gone')
    })

    it('returns the new Command so the consumer can chain', () => {
        const { command } = buildRemove()

        expect(command.name()).toBe('remove')
    })
})
