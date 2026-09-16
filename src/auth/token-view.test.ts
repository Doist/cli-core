import { afterEach, describe, expect, it, vi } from 'vitest'

import { CliError } from '../errors.js'
import { buildProgram, installCapturedStream } from '../test-support/cli-harness.js'
import { fakeRefreshProvider, installLockPath } from '../test-support/refresh-fixtures.js'
import {
    type TestAccount as Account,
    type TokenStoreHarness,
    alanGrant,
    buildSingleEntryStore,
    buildTokenStore,
} from '../testing/accounts.js'
import { attachTokenViewCommand } from './token-view.js'
import type { TokenBundle } from './types.js'

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

        expect(stdoutSpy()).toHaveBeenCalledWith('tok-xyz')
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
        expect(stdoutSpy()).toHaveBeenCalledWith('tok-xyz')
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
        expect(stdoutSpy()).toHaveBeenCalledWith('tok-xyz')
    })

    it('calls store.active(undefined) when --user is absent', async () => {
        const { program, parent: auth } = buildProgram('auth')
        const { store, activeSpy } = buildStore()
        attachTokenViewCommand<Account>(auth, { store })

        await program.parseAsync(['node', 'cli', 'auth', 'token'])

        expect(activeSpy).toHaveBeenCalledWith(undefined)
        expect(stdoutSpy()).toHaveBeenCalledWith('tok-xyz')
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

    describe('with refresh', () => {
        const lockPath = installLockPath()

        function buildBundleStore(bundle: TokenBundle): TokenStoreHarness<Account> {
            return buildTokenStore<Account>({ entries: [{ account, isDefault: true, bundle }] })
        }

        const expiring = (): TokenBundle => ({
            accessToken: 'tok-old',
            refreshToken: 'r-old',
            accessTokenExpiresAt: Date.now() + 1_000,
        })

        it('prints the rotated token when the stored one is expiring', async () => {
            const { program, parent: auth } = buildProgram('auth')
            const { store, state } = buildBundleStore(expiring())
            const { provider, refreshSpy } = fakeRefreshProvider()
            attachTokenViewCommand<Account>(auth, {
                store,
                refresh: { provider, lockPath: lockPath() },
            })

            await program.parseAsync(['node', 'cli', 'auth', 'token'])

            expect(refreshSpy).toHaveBeenCalledTimes(1)
            expect(state.setBundleCalls).toHaveLength(1)
            expect(stdoutSpy()).toHaveBeenCalledWith('tok_new')
        })

        it('prints the stored token without a refresh call when it is still fresh', async () => {
            const { program, parent: auth } = buildProgram('auth')
            const { store } = buildBundleStore({
                ...expiring(),
                accessTokenExpiresAt: Date.now() + 600_000,
            })
            const { provider, refreshSpy } = fakeRefreshProvider()
            attachTokenViewCommand<Account>(auth, {
                store,
                refresh: { provider, lockPath: lockPath() },
            })

            await program.parseAsync(['node', 'cli', 'auth', 'token'])

            expect(refreshSpy).not.toHaveBeenCalled()
            expect(stdoutSpy()).toHaveBeenCalledWith('tok-old')
        })

        it('falls back to the stored token when the credential has no refresh token', async () => {
            const { program, parent: auth } = buildProgram('auth')
            const { store, activeSpy } = buildBundleStore({
                accessToken: 'tok-old',
                accessTokenExpiresAt: Date.now(),
            })
            const { provider, refreshSpy } = fakeRefreshProvider()
            attachTokenViewCommand<Account>(auth, {
                store,
                refresh: { provider, lockPath: lockPath() },
            })

            await program.parseAsync(['node', 'cli', 'auth', 'token'])

            expect(refreshSpy).not.toHaveBeenCalled()
            expect(activeSpy).toHaveBeenCalledWith(undefined)
            expect(stdoutSpy()).toHaveBeenCalledWith('tok-old')
        })

        it('surfaces AUTH_REFRESH_EXPIRED instead of printing a dead token', async () => {
            const { program, parent: auth } = buildProgram('auth')
            const { store } = buildBundleStore(expiring())
            const { provider } = fakeRefreshProvider(async () => {
                throw new CliError('AUTH_REFRESH_EXPIRED', 'invalid_grant')
            })
            attachTokenViewCommand<Account>(auth, {
                store,
                refresh: { provider, lockPath: lockPath() },
            })

            await expect(
                program.parseAsync(['node', 'cli', 'auth', 'token']),
            ).rejects.toMatchObject({ constructor: CliError, code: 'AUTH_REFRESH_EXPIRED' })
            expect(stdoutSpy()).not.toHaveBeenCalled()
        })

        it('surfaces AUTH_REFRESH_TRANSIENT when the stored token has already expired', async () => {
            const { program, parent: auth } = buildProgram('auth')
            const { store } = buildBundleStore({
                ...expiring(),
                accessTokenExpiresAt: Date.now() - 1_000,
            })
            const { provider } = fakeRefreshProvider(async () => {
                throw new CliError('AUTH_REFRESH_TRANSIENT', 'network down')
            })
            attachTokenViewCommand<Account>(auth, {
                store,
                refresh: { provider, lockPath: lockPath() },
            })

            await expect(
                program.parseAsync(['node', 'cli', 'auth', 'token']),
            ).rejects.toMatchObject({ constructor: CliError, code: 'AUTH_REFRESH_TRANSIENT' })
            expect(stdoutSpy()).not.toHaveBeenCalled()
        })

        it('does not refresh when envVarName is set and the env var is populated', async () => {
            vi.stubEnv('TODOIST_API_TOKEN', 'env-token')
            const { program, parent: auth } = buildProgram('auth')
            const { store } = buildBundleStore(expiring())
            const { provider, refreshSpy } = fakeRefreshProvider()
            attachTokenViewCommand<Account>(auth, {
                store,
                envVarName: 'TODOIST_API_TOKEN',
                refresh: { provider, lockPath: lockPath() },
            })

            await expect(
                program.parseAsync(['node', 'cli', 'auth', 'token']),
            ).rejects.toMatchObject({ constructor: CliError, code: 'TOKEN_FROM_ENV' })
            expect(refreshSpy).not.toHaveBeenCalled()
        })

        it('threads --user into the refresh and still reports ACCOUNT_NOT_FOUND on a miss', async () => {
            const { program, parent: auth } = buildProgram('auth')
            const { store } = buildBundleStore(expiring())
            const { provider, refreshSpy } = fakeRefreshProvider()
            attachTokenViewCommand<Account>(auth, {
                store,
                refresh: { provider, lockPath: lockPath() },
            })

            await expect(
                program.parseAsync(['node', 'cli', 'auth', 'token', '--user', 'ghost']),
            ).rejects.toMatchObject({ constructor: CliError, code: 'ACCOUNT_NOT_FOUND' })
            expect(refreshSpy).not.toHaveBeenCalled()

            await program.parseAsync(['node', 'cli', 'auth', 'token', '--user', 'alan@ingen.com'])
            expect(refreshSpy).toHaveBeenCalledTimes(1)
            expect(stdoutSpy()).toHaveBeenCalledWith('tok_new')
        })
    })
})
