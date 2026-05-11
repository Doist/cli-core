import { Command } from 'commander'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { CliError } from '../errors.js'
import { attachTokenViewCommand } from './token-view.js'
import type { TokenStore } from './types.js'

type Account = { id: string; label?: string; email: string }

const account: Account = { id: '1', label: 'me', email: 'a@b' }

function buildStore(
    initial: { token: string; account: Account } | null = { token: 'tok-xyz', account },
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

describe('attachTokenViewCommand', () => {
    let stdoutSpy: ReturnType<typeof vi.spyOn>

    beforeEach(() => {
        stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    })

    afterEach(() => {
        stdoutSpy.mockRestore()
        vi.unstubAllEnvs()
    })

    it('prints the bare stored token to stdout', async () => {
        const program = new Command()
        program.exitOverride()
        const auth = program.command('auth')
        const { store } = buildStore()
        attachTokenViewCommand<Account>(auth, { store })

        await program.parseAsync(['node', 'cli', 'auth', 'token'])

        expect(stdoutSpy).toHaveBeenCalledWith('tok-xyz')
    })

    it('appends a newline only when stdout is a TTY', async () => {
        const program = new Command()
        program.exitOverride()
        const auth = program.command('auth')
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

        expect(stdoutSpy).toHaveBeenNthCalledWith(1, 'tok-xyz')
        expect(stdoutSpy).toHaveBeenNthCalledWith(2, '\n')
    })

    it('throws CliError(TOKEN_FROM_ENV) when envVarName is set and env is populated', async () => {
        vi.stubEnv('TODOIST_API_TOKEN', 'env-token')
        const program = new Command()
        program.exitOverride()
        const auth = program.command('auth')
        const { store, activeSpy } = buildStore()
        attachTokenViewCommand<Account>(auth, { store, envVarName: 'TODOIST_API_TOKEN' })

        await expect(program.parseAsync(['node', 'cli', 'auth', 'token'])).rejects.toMatchObject({
            constructor: CliError,
            code: 'TOKEN_FROM_ENV',
        })
        expect(activeSpy).not.toHaveBeenCalled()
        expect(stdoutSpy).not.toHaveBeenCalled()
    })

    it('prints normally when envVarName is set but env is empty', async () => {
        vi.stubEnv('TODOIST_API_TOKEN', '')
        const program = new Command()
        program.exitOverride()
        const auth = program.command('auth')
        const { store } = buildStore()
        attachTokenViewCommand<Account>(auth, { store, envVarName: 'TODOIST_API_TOKEN' })

        await program.parseAsync(['node', 'cli', 'auth', 'token'])

        expect(stdoutSpy).toHaveBeenCalledWith('tok-xyz')
    })

    it('throws CliError(NOT_AUTHENTICATED) when the store is empty', async () => {
        const program = new Command()
        program.exitOverride()
        const auth = program.command('auth')
        const { store } = buildStore(null)
        attachTokenViewCommand<Account>(auth, { store })

        await expect(program.parseAsync(['node', 'cli', 'auth', 'token'])).rejects.toMatchObject({
            constructor: CliError,
            code: 'NOT_AUTHENTICATED',
        })
        expect(stdoutSpy).not.toHaveBeenCalled()
    })

    it('registers under a custom name when supplied', async () => {
        const program = new Command()
        program.exitOverride()
        const auth = program.command('auth')
        const { store } = buildStore()
        const cmd = attachTokenViewCommand<Account>(auth, { store, name: 'view' })

        expect(cmd.name()).toBe('view')

        await program.parseAsync(['node', 'cli', 'auth', 'view'])
        expect(stdoutSpy).toHaveBeenCalledWith('tok-xyz')
    })

    it('returns the new Command so the consumer can chain', () => {
        const program = new Command()
        const auth = program.command('auth')
        const { store } = buildStore()
        const cmd = attachTokenViewCommand<Account>(auth, { store })

        expect(cmd.name()).toBe('token')
    })
})
