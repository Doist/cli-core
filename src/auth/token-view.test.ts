import { afterEach, describe, expect, it, vi } from 'vitest'

import { CliError } from '../errors.js'
import { buildProgram, installCapturedStream } from '../test-support/cli-harness.js'
import {
    type TestAccount as Account,
    type TokenStoreHarness,
    alanGrant,
    buildSingleEntryStore,
} from '../testing/accounts.js'
import { attachTokenViewCommand } from './token-view.js'

const account = alanGrant

function buildStore(
    initial: { token: string; account: Account } | null = { token: 'tok-xyz', account },
): TokenStoreHarness<Account> {
    return buildSingleEntryStore(initial)
}

describe('attachTokenViewCommand', () => {
    const stdoutSpy = installCapturedStream()

    afterEach(() => {
        vi.unstubAllEnvs()
    })

    it('writes exactly the bare token (no trailing newline) when stdout is not a TTY', async () => {
        const { program, parent: auth } = buildProgram('auth')
        const { store } = buildStore()
        attachTokenViewCommand<Account>(auth, { store })

        const originalTTY = process.stdout.isTTY
        Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true })
        try {
            await program.parseAsync(['node', 'cli', 'auth', 'token'])
        } finally {
            Object.defineProperty(process.stdout, 'isTTY', {
                value: originalTTY,
                configurable: true,
            })
        }

        const emitted = stdoutSpy()
            .mock.calls.map((call: unknown[]) => call[0])
            .join('')
        expect(emitted).toBe('tok-xyz')
        expect(stdoutSpy()).toHaveBeenCalledTimes(1)
    })

    it('appends a newline only when stdout is a TTY', async () => {
        const { program, parent: auth } = buildProgram('auth')
        const { store } = buildStore()
        attachTokenViewCommand<Account>(auth, { store })

        const originalTTY = process.stdout.isTTY
        Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true })
        try {
            await program.parseAsync(['node', 'cli', 'auth', 'token'])
        } finally {
            Object.defineProperty(process.stdout, 'isTTY', {
                value: originalTTY,
                configurable: true,
            })
        }

        const emitted = stdoutSpy()
            .mock.calls.map((call: unknown[]) => call[0])
            .join('')
        expect(emitted).toBe('tok-xyz\n')
    })

    it('ignores EPIPE when downstream closes the pipe early', async () => {
        const { program, parent: auth } = buildProgram('auth')
        const { store } = buildStore({ token: 'redacted-token', account })
        const brokenPipe = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })
        attachTokenViewCommand<Account>(auth, { store })
        stdoutSpy().mockImplementation(((...args: unknown[]) => {
            const callback = args.findLast((arg) => typeof arg === 'function') as
                | ((error?: Error) => void)
                | undefined
            queueMicrotask(() => {
                process.stdout.emit('error', brokenPipe)
                callback?.(brokenPipe)
            })
            return false
        }) as typeof process.stdout.write)

        await program.parseAsync(['node', 'cli', 'auth', 'token'])
    })

    it('propagates non-EPIPE stdout write errors', async () => {
        const { program, parent: auth } = buildProgram('auth')
        const { store } = buildStore({ token: 'redacted-token', account })
        const writeError = Object.assign(new Error('write failed'), { code: 'EIO' })
        attachTokenViewCommand<Account>(auth, { store })
        stdoutSpy().mockImplementation((() => {
            queueMicrotask(() => {
                process.stdout.emit('error', writeError)
            })
            return false
        }) as typeof process.stdout.write)

        await expect(program.parseAsync(['node', 'cli', 'auth', 'token'])).rejects.toBe(writeError)
    })

    it('throws CliError(TOKEN_FROM_ENV) when envVarName is set and env is populated', async () => {
        vi.stubEnv('TODOIST_API_TOKEN', 'env-token')
        const { program, parent: auth } = buildProgram('auth')
        const { store, activeSpy } = buildStore()
        attachTokenViewCommand<Account>(auth, { store, envVarName: 'TODOIST_API_TOKEN' })

        await expect(program.parseAsync(['node', 'cli', 'auth', 'token'])).rejects.toMatchObject({
            constructor: CliError,
            code: 'TOKEN_FROM_ENV',
        })
        expect(activeSpy).not.toHaveBeenCalled()
        expect(stdoutSpy()).not.toHaveBeenCalled()
    })

    it('prints normally when envVarName is set but env is empty', async () => {
        vi.stubEnv('TODOIST_API_TOKEN', '')
        const { program, parent: auth } = buildProgram('auth')
        const { store } = buildStore()
        attachTokenViewCommand<Account>(auth, { store, envVarName: 'TODOIST_API_TOKEN' })

        await program.parseAsync(['node', 'cli', 'auth', 'token'])

        expect(stdoutSpy().mock.calls[0]?.[0]).toBe('tok-xyz')
    })

    it('throws CliError(NOT_AUTHENTICATED) when the store is empty', async () => {
        const { program, parent: auth } = buildProgram('auth')
        const { store } = buildStore(null)
        attachTokenViewCommand<Account>(auth, { store })

        await expect(program.parseAsync(['node', 'cli', 'auth', 'token'])).rejects.toMatchObject({
            constructor: CliError,
            code: 'NOT_AUTHENTICATED',
        })
        expect(stdoutSpy()).not.toHaveBeenCalled()
    })

    it('registers under a custom name when supplied', async () => {
        const { program, parent: auth } = buildProgram('auth')
        const { store } = buildStore()
        const cmd = attachTokenViewCommand<Account>(auth, { store, name: 'view' })

        expect(cmd.name()).toBe('view')

        await program.parseAsync(['node', 'cli', 'auth', 'view'])
        expect(stdoutSpy().mock.calls[0]?.[0]).toBe('tok-xyz')
    })

    it('returns the new Command so the consumer can chain', () => {
        const { parent: auth } = buildProgram('auth')
        const { store } = buildStore()
        const cmd = attachTokenViewCommand<Account>(auth, { store })

        expect(cmd.name()).toBe('token')
    })

    it('threads --user ref to store.active(ref) and prints the matched token', async () => {
        const { program, parent: auth } = buildProgram('auth')
        const { store, activeSpy } = buildStore()
        attachTokenViewCommand<Account>(auth, { store })

        await program.parseAsync(['node', 'cli', 'auth', 'token', '--user', 'alan@ingen.com'])

        expect(activeSpy).toHaveBeenCalledWith('alan@ingen.com')
        expect(stdoutSpy().mock.calls[0]?.[0]).toBe('tok-xyz')
    })

    it('calls store.active(undefined) when --user is absent', async () => {
        const { program, parent: auth } = buildProgram('auth')
        const { store, activeSpy } = buildStore()
        attachTokenViewCommand<Account>(auth, { store })

        await program.parseAsync(['node', 'cli', 'auth', 'token'])

        expect(activeSpy).toHaveBeenCalledWith(undefined)
        expect(stdoutSpy().mock.calls[0]?.[0]).toBe('tok-xyz')
    })

    it('throws ACCOUNT_NOT_FOUND when --user does not match a stored account', async () => {
        const { program, parent: auth } = buildProgram('auth')
        const { store } = buildStore(null)
        attachTokenViewCommand<Account>(auth, { store })

        await expect(
            program.parseAsync(['node', 'cli', 'auth', 'token', '--user', 'ghost']),
        ).rejects.toMatchObject({
            constructor: CliError,
            code: 'ACCOUNT_NOT_FOUND',
        })
        expect(stdoutSpy()).not.toHaveBeenCalled()
    })
})
