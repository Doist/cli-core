import { describe, expect, it } from 'vitest'

import { CliError } from '../errors.js'
import { buildProgram, installCapturedStream } from '../test-support/cli-harness.js'
import {
    type TestAccount as Account,
    type TokenStoreHarness,
    alanGrant,
    buildTokenStore,
} from '../testing/accounts.js'
import { attachRefreshTokenViewCommand } from './refresh-token-view.js'
import type { TokenBundle } from './types.js'

const account = alanGrant
const defaultBundle: TokenBundle = {
    accessToken: 'tok-xyz',
    refreshToken: 'refresh-xyz',
}

function buildStore(
    bundle: TokenBundle | null = defaultBundle,
    overrides?: Parameters<typeof buildTokenStore<Account>>[0]['overrides'],
): TokenStoreHarness<Account> {
    return buildTokenStore<Account>({
        entries: bundle ? [{ account, isDefault: true, bundle }] : [],
        overrides,
    })
}

describe('attachRefreshTokenViewCommand', () => {
    const stdoutSpy = installCapturedStream()

    it('writes exactly the bare refresh token (no trailing newline) when stdout is not a TTY', async () => {
        const { program, parent: auth } = buildProgram('auth')
        const { store } = buildStore()
        attachRefreshTokenViewCommand<Account>(auth, { store })

        const originalTTY = process.stdout.isTTY
        Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true })
        try {
            await program.parseAsync(['node', 'cli', 'auth', 'refresh-token', 'view'])
        } finally {
            Object.defineProperty(process.stdout, 'isTTY', {
                value: originalTTY,
                configurable: true,
            })
        }

        const emitted = stdoutSpy()
            .mock.calls.map((call: unknown[]) => call[0])
            .join('')
        expect(emitted).toBe('refresh-xyz')
        expect(stdoutSpy()).toHaveBeenCalledTimes(1)
    })

    it('appends a newline only when stdout is a TTY', async () => {
        const { program, parent: auth } = buildProgram('auth')
        const { store } = buildStore()
        attachRefreshTokenViewCommand<Account>(auth, { store })

        const originalTTY = process.stdout.isTTY
        Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true })
        try {
            await program.parseAsync(['node', 'cli', 'auth', 'refresh-token', 'view'])
        } finally {
            Object.defineProperty(process.stdout, 'isTTY', {
                value: originalTTY,
                configurable: true,
            })
        }

        const emitted = stdoutSpy()
            .mock.calls.map((call: unknown[]) => call[0])
            .join('')
        expect(emitted).toBe('refresh-xyz\n')
    })

    it('throws CliError(NOT_AUTHENTICATED) when the store is empty', async () => {
        const { program, parent: auth } = buildProgram('auth')
        const { store } = buildStore(null)
        attachRefreshTokenViewCommand<Account>(auth, { store })

        await expect(
            program.parseAsync(['node', 'cli', 'auth', 'refresh-token', 'view']),
        ).rejects.toMatchObject({
            constructor: CliError,
            code: 'NOT_AUTHENTICATED',
        })
        expect(stdoutSpy()).not.toHaveBeenCalled()
    })

    it('throws AUTH_REFRESH_UNAVAILABLE when the store cannot read bundles', async () => {
        const { program, parent: auth } = buildProgram('auth')
        const { store, activeSpy } = buildStore(defaultBundle, { activeBundle: undefined })
        attachRefreshTokenViewCommand<Account>(auth, { store })

        await expect(
            program.parseAsync(['node', 'cli', 'auth', 'refresh-token', 'view']),
        ).rejects.toMatchObject({
            constructor: CliError,
            code: 'AUTH_REFRESH_UNAVAILABLE',
        })
        expect(activeSpy).not.toHaveBeenCalled()
        expect(stdoutSpy()).not.toHaveBeenCalled()
    })

    it('throws AUTH_REFRESH_UNAVAILABLE when the active bundle has no refresh token', async () => {
        const { program, parent: auth } = buildProgram('auth')
        const { store } = buildStore({ accessToken: 'tok-xyz' })
        attachRefreshTokenViewCommand<Account>(auth, { store })

        await expect(
            program.parseAsync(['node', 'cli', 'auth', 'refresh-token', 'view']),
        ).rejects.toMatchObject({
            constructor: CliError,
            code: 'AUTH_REFRESH_UNAVAILABLE',
        })
        expect(stdoutSpy()).not.toHaveBeenCalled()
    })

    it('registers under custom group and view names when supplied', async () => {
        const { program, parent: auth } = buildProgram('auth')
        const { store } = buildStore()
        const cmd = attachRefreshTokenViewCommand<Account>(auth, {
            store,
            groupName: 'refresh',
            name: 'show',
        })

        expect(cmd.name()).toBe('show')

        await program.parseAsync(['node', 'cli', 'auth', 'refresh', 'show'])
        expect(stdoutSpy()).toHaveBeenCalledWith('refresh-xyz')
    })

    it('returns the view Command so the consumer can chain', () => {
        const { parent: auth } = buildProgram('auth')
        const { store } = buildStore()
        const cmd = attachRefreshTokenViewCommand<Account>(auth, { store })

        expect(cmd.name()).toBe('view')
    })

    it('threads --user ref to store.activeBundle(ref) and prints the matched refresh token', async () => {
        const { program, parent: auth } = buildProgram('auth')
        const { store, activeSpy } = buildStore()
        attachRefreshTokenViewCommand<Account>(auth, { store })

        await program.parseAsync([
            'node',
            'cli',
            'auth',
            'refresh-token',
            'view',
            '--user',
            'alan@ingen.com',
        ])

        expect(store.activeBundle).toHaveBeenCalledWith('alan@ingen.com')
        expect(activeSpy).not.toHaveBeenCalled()
        expect(stdoutSpy()).toHaveBeenCalledWith('refresh-xyz')
    })

    it('calls store.activeBundle(undefined) when --user is absent', async () => {
        const { program, parent: auth } = buildProgram('auth')
        const { store, activeSpy } = buildStore()
        attachRefreshTokenViewCommand<Account>(auth, { store })

        await program.parseAsync(['node', 'cli', 'auth', 'refresh-token', 'view'])

        expect(store.activeBundle).toHaveBeenCalledWith(undefined)
        expect(activeSpy).not.toHaveBeenCalled()
        expect(stdoutSpy()).toHaveBeenCalledWith('refresh-xyz')
    })

    it('throws ACCOUNT_NOT_FOUND when --user does not match a stored account', async () => {
        const { program, parent: auth } = buildProgram('auth')
        const { store } = buildStore(null)
        attachRefreshTokenViewCommand<Account>(auth, { store })

        await expect(
            program.parseAsync(['node', 'cli', 'auth', 'refresh-token', 'view', '--user', 'ghost']),
        ).rejects.toMatchObject({
            constructor: CliError,
            code: 'ACCOUNT_NOT_FOUND',
        })
        expect(stdoutSpy()).not.toHaveBeenCalled()
    })
})
