import { Command } from 'commander'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { CliError } from '../errors.js'
import { attachLoginCommand } from './login.js'
import type { AuthProvider, TokenStore } from './types.js'

vi.mock('./flow.js', () => ({
    runOAuthFlow: vi.fn(),
}))

const { runOAuthFlow } = await import('./flow.js')
const mockedRunOAuthFlow = vi.mocked(runOAuthFlow)

type Account = { id: string; label?: string; email: string }

const account: Account = { id: '1', label: 'me', email: 'a@b' }

const provider: AuthProvider<Account> = {
    async authorize() {
        return { authorizeUrl: '', handshake: {} }
    },
    async exchangeCode() {
        return { accessToken: 'tok' }
    },
    async validateToken() {
        return account
    },
}

const store: TokenStore<Account> = {
    async active() {
        return null
    },
    async set() {},
    async clear() {},
}

const renderSuccess = () => '<html>ok</html>'
const renderError = () => '<html>err</html>'

function build(
    overrides: Partial<Parameters<typeof attachLoginCommand<Account>>[1]> = {},
    setup?: (cmd: Command) => void,
): {
    program: Command
    onSuccess: ReturnType<typeof vi.fn>
    resolveScopes: ReturnType<typeof vi.fn>
} {
    const program = new Command()
    program.exitOverride()
    const auth = program.command('auth')
    const onSuccess = vi.fn()
    const resolveScopes = vi.fn(() => ['read'])
    const login = attachLoginCommand<Account>(auth, {
        provider,
        store,
        preferredPort: 8765,
        portFallbackCount: 5,
        resolveScopes,
        renderSuccess,
        renderError,
        onSuccess,
        ...overrides,
    })
    setup?.(login)
    return { program, onSuccess, resolveScopes }
}

describe('attachLoginCommand', () => {
    beforeEach(() => {
        mockedRunOAuthFlow.mockReset()
        mockedRunOAuthFlow.mockResolvedValue({ token: 'tok', account })
    })

    it('drives runOAuthFlow with the standard option set in human mode', async () => {
        const { program, onSuccess, resolveScopes } = build()

        await program.parseAsync(['node', 'cli', 'auth', 'login'])

        expect(resolveScopes).toHaveBeenCalledWith({ readOnly: false, flags: {} })
        expect(mockedRunOAuthFlow).toHaveBeenCalledTimes(1)
        const call = mockedRunOAuthFlow.mock.calls[0][0]
        expect(call.scopes).toEqual(['read'])
        expect(call.readOnly).toBe(false)
        expect(call.flags).toEqual({})
        expect(call.preferredPort).toBe(8765)
        expect(call.portFallbackCount).toBe(5)
        expect(call.renderSuccess).toBe(renderSuccess)
        expect(call.renderError).toBe(renderError)
        expect(call.onAuthorizeUrl).toBeUndefined()
        expect(onSuccess).toHaveBeenCalledWith(account, { json: false, ndjson: false })
    })

    it('threads --read-only into resolveScopes and runOAuthFlow', async () => {
        const { program, resolveScopes } = build()

        await program.parseAsync(['node', 'cli', 'auth', 'login', '--read-only'])

        expect(resolveScopes).toHaveBeenCalledWith({ readOnly: true, flags: {} })
        expect(mockedRunOAuthFlow.mock.calls[0][0].readOnly).toBe(true)
    })

    it('overrides preferredPort when --callback-port is supplied', async () => {
        const { program } = build()

        await program.parseAsync(['node', 'cli', 'auth', 'login', '--callback-port', '9000'])

        expect(mockedRunOAuthFlow.mock.calls[0][0].preferredPort).toBe(9000)
    })

    it('rejects non-integer --callback-port values via CliError', async () => {
        const { program } = build()

        await expect(
            program.parseAsync(['node', 'cli', 'auth', 'login', '--callback-port', 'abc']),
        ).rejects.toBeInstanceOf(CliError)
    })

    it('rejects out-of-range --callback-port values via CliError', async () => {
        const { program } = build()

        await expect(
            program.parseAsync(['node', 'cli', 'auth', 'login', '--callback-port', '70000']),
        ).rejects.toBeInstanceOf(CliError)
    })

    it('suppresses the authorize-url fallback print under --json', async () => {
        const { program, onSuccess } = build()

        await program.parseAsync(['node', 'cli', 'auth', 'login', '--json'])

        const call = mockedRunOAuthFlow.mock.calls[0][0]
        expect(call.onAuthorizeUrl).toBeTypeOf('function')
        // Confirm the supplied stub is a no-op rather than a stdout writer.
        expect(call.onAuthorizeUrl?.('https://example.com')).toBeUndefined()
        expect(onSuccess).toHaveBeenCalledWith(account, { json: true, ndjson: false })
    })

    it('suppresses the authorize-url fallback print under --ndjson', async () => {
        const { program, onSuccess } = build()

        await program.parseAsync(['node', 'cli', 'auth', 'login', '--ndjson'])

        expect(mockedRunOAuthFlow.mock.calls[0][0].onAuthorizeUrl).toBeTypeOf('function')
        expect(onSuccess).toHaveBeenCalledWith(account, { json: false, ndjson: true })
    })

    it('exposes consumer-attached options in flags but strips the standard ones', async () => {
        const { program, resolveScopes } = build({}, (login) => {
            login.option('--additional-scopes <list>', 'extra scopes', (v: string) => v)
        })

        await program.parseAsync([
            'node',
            'cli',
            'auth',
            'login',
            '--read-only',
            '--callback-port',
            '9000',
            '--json',
            '--additional-scopes',
            'projects:read',
        ])

        const call = mockedRunOAuthFlow.mock.calls[0][0]
        // Standard flags are consumed by the registrar, not leaked into flags.
        expect(call.flags).toEqual({ additionalScopes: 'projects:read' })
        expect(resolveScopes).toHaveBeenCalledWith({
            readOnly: true,
            flags: { additionalScopes: 'projects:read' },
        })
    })

    it('forwards a custom openBrowser to runOAuthFlow', async () => {
        const openBrowser = vi.fn(async () => undefined)
        const { program } = build({ openBrowser })

        await program.parseAsync(['node', 'cli', 'auth', 'login'])

        expect(mockedRunOAuthFlow.mock.calls[0][0].openBrowser).toBe(openBrowser)
    })

    it('returns the new Command so the consumer can chain', () => {
        const program = new Command()
        const auth = program.command('auth')
        const login = attachLoginCommand<Account>(auth, {
            provider,
            store,
            preferredPort: 8765,
            resolveScopes: () => ['read'],
            renderSuccess,
            renderError,
            onSuccess: () => {},
        })

        expect(login.name()).toBe('login')
    })
})
