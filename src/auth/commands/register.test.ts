import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { Command } from 'commander'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createConfigTokenStore } from '../store/config.js'
import type { AuthProvider } from '../types.js'
import { registerAuthCommand } from './register.js'

type Account = { id: string; label?: string; email: string }

let dir: string
let path: string
let originalLog: typeof console.log
let logs: string[]

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cli-core-register-'))
    path = join(dir, 'config.json')
    logs = []
    originalLog = console.log
    console.log = (...args: unknown[]) => {
        logs.push(args.map(String).join(' '))
    }
})

afterEach(async () => {
    console.log = originalLog
    await rm(dir, { recursive: true, force: true })
})

function fakeProvider(account: Account = { id: '1', email: 'a@b' }): AuthProvider<Account> {
    return {
        async authorize(input) {
            return {
                authorizeUrl: `https://example.com/oauth/authorize?state=${input.state}`,
                handshake: { codeVerifier: 'v1' },
            }
        },
        async exchangeCode() {
            return { accessToken: 'tok-1' }
        },
        async validateToken() {
            return account
        },
        async acceptPastedToken({ token }) {
            return { ...account, label: token.slice(0, 4) }
        },
    }
}

type BuildOptions = {
    flat?: boolean
    commandName?: string
    loginFlags?: Parameters<typeof registerAuthCommand>[1]['loginFlags']
    resolveScopes?: Parameters<typeof registerAuthCommand>[1]['resolveScopes']
    provider?: AuthProvider<Account>
    callbackEnvVar?: string
    openBrowser?: (url: string) => Promise<void>
}

function build(opts: BuildOptions = {}): Command {
    const program = new Command()
    program.exitOverride()
    const store = createConfigTokenStore<Account>({ configPath: path, multiUser: true })
    registerAuthCommand<Account>(program, {
        appName: 'test',
        displayName: 'Test',
        provider: opts.provider ?? fakeProvider(),
        store,
        resolveScopes: opts.resolveScopes ?? (() => ['read']),
        callbackPort: { preferred: 0, envVar: opts.callbackEnvVar },
        renderSuccess: () => '',
        renderError: () => '',
        flat: opts.flat,
        commandName: opts.commandName,
        loginFlags: opts.loginFlags,
        openBrowser: opts.openBrowser,
    })
    return program
}

/**
 * Wrap a provider so we can capture the redirectUri from inside `authorize()`
 * and use it to drive the callback from the `openBrowser` mock.
 */
function instrument(provider: AuthProvider<Account>): {
    provider: AuthProvider<Account>
    getRedirect: () => string
} {
    let redirectUri = ''
    const wrapped: AuthProvider<Account> = {
        ...provider,
        async authorize(input) {
            redirectUri = input.redirectUri
            return provider.authorize(input)
        },
    }
    return { provider: wrapped, getRedirect: () => redirectUri }
}

describe('registerAuthCommand', () => {
    it('nests subcommands under `auth` by default', () => {
        const program = build()
        const auth = program.commands.find((c) => c.name() === 'auth')
        expect(auth).toBeDefined()
        const names = (auth?.commands ?? []).map((c) => c.name())
        expect(names).toEqual(expect.arrayContaining(['login', 'logout', 'status', 'token']))
    })

    it('registers top-level subcommands when flat is true', () => {
        const program = build({ flat: true })
        const names = program.commands.map((c) => c.name())
        expect(names).toEqual(expect.arrayContaining(['login', 'logout', 'status', 'token']))
    })

    it('honours commandName override', () => {
        const program = build({ commandName: 'account' })
        const account = program.commands.find((c) => c.name() === 'account')
        expect(account).toBeDefined()
    })

    it('login does not register a --token flag (secrets-via-argv prohibited)', () => {
        const program = build({ flat: true })
        const login = program.commands.find((c) => c.name() === 'login')
        const tokenOpt = login?.options.find((o) => o.long === '--token')
        expect(tokenOpt).toBeUndefined()
    })

    it('login drives the OAuth flow end-to-end', async () => {
        const { provider, getRedirect } = instrument(fakeProvider())
        const openBrowser = vi.fn(async (url: string) => {
            const state = new URL(url).searchParams.get('state') ?? ''
            await fetch(`${getRedirect()}?code=abc&state=${state}`)
        })
        const program = build({ flat: true, provider, openBrowser })
        await program.parseAsync(['node', 'test', 'login'])
        const store = createConfigTokenStore<Account>({ configPath: path, multiUser: true })
        expect((await store.active())?.token).toBe('tok-1')
    })

    it('loginFlags parsed values reach resolveScopes via the flags bag', async () => {
        const resolveScopes = vi.fn(({ flags }) => {
            expect(flags.additionalScopes).toEqual(['app-management', 'backups'])
            return ['data:read_write', 'app-management', 'backups']
        })
        const { provider, getRedirect } = instrument(fakeProvider())
        const program = build({
            flat: true,
            provider,
            resolveScopes,
            loginFlags: [
                {
                    flags: '--additional-scopes <list>',
                    description: 'Extra scopes',
                    parse: (raw: string) => raw.split(',').map((s) => s.trim()),
                },
            ],
            openBrowser: async (url) => {
                const state = new URL(url).searchParams.get('state') ?? ''
                await fetch(`${getRedirect()}?code=abc&state=${state}`)
            },
        })

        await program.parseAsync([
            'node',
            'test',
            'login',
            '--additional-scopes',
            'app-management,backups',
        ])
        expect(resolveScopes).toHaveBeenCalledTimes(1)
    })

    it('--callback-port flag wins over env override', async () => {
        process.env.TEST_CB_PORT = '40001'
        const { provider, getRedirect } = instrument(fakeProvider())
        const seenPorts: number[] = []
        const program = build({
            flat: true,
            provider,
            callbackEnvVar: 'TEST_CB_PORT',
            openBrowser: async (url) => {
                const port = Number.parseInt(getRedirect().split(':')[2].split('/')[0], 10)
                seenPorts.push(port)
                const state = new URL(url).searchParams.get('state') ?? ''
                await fetch(`${getRedirect()}?code=abc&state=${state}`)
            },
        })
        try {
            await program.parseAsync(['node', 'test', 'login', '--callback-port', '0'])
            // CLI flag was 0 (OS-assigned ephemeral); env was 40001.
            // If the env had won, the bind would have been on 40001.
            expect(seenPorts[0]).not.toBe(40001)
        } finally {
            delete process.env.TEST_CB_PORT
        }
    })

    it('--callback-port rejects non-integer / out-of-range values with AUTH_PORT_BIND_FAILED', async () => {
        const program = build({ flat: true })
        await expect(
            program.parseAsync(['node', 'test', 'login', '--callback-port', 'foo']),
        ).rejects.toMatchObject({ code: 'AUTH_PORT_BIND_FAILED' })
        await expect(
            program.parseAsync(['node', 'test', 'login', '--callback-port', '70000']),
        ).rejects.toMatchObject({ code: 'AUTH_PORT_BIND_FAILED' })
    })

    it('status --json emits an envelope', async () => {
        const program = build({ flat: true })
        await program.parseAsync(['node', 'test', 'status', '--json'])
        const out = JSON.parse(logs[0]) as {
            displayName: string
            backend: string
            envTokenSet: boolean
        }
        expect(out.displayName).toBe('Test')
        expect(out.envTokenSet).toBe(false)
    })

    it('logout --all clears and reports it', async () => {
        // Seed an account so logout has something to report after clearing.
        const store = createConfigTokenStore<Account>({ configPath: path, multiUser: true })
        await store.set({ id: '1', email: 'a@b' }, 'tok-1')

        const program = build({ flat: true })
        await program.parseAsync(['node', 'test', 'logout', '--all', '--json'])
        const last = JSON.parse(logs[logs.length - 1]) as { cleared: string }
        expect(last.cleared).toBe('all')
    })

    it('token (no subcommand) prints the active token', async () => {
        const store = createConfigTokenStore<Account>({ configPath: path, multiUser: true })
        await store.set({ id: '1', email: 'a@b' }, 'tok-xyz')
        const program = build({ flat: true })
        await program.parseAsync(['node', 'test', 'token'])
        expect(logs[0]).toBe('tok-xyz')
    })

    it('token set reads from piped stdin and persists', async () => {
        const program = build({ flat: true })
        const originalStdin = process.stdin
        const piped = Object.assign(Readable.from(['paste-me']), { isTTY: false })
        Object.defineProperty(process, 'stdin', { value: piped, configurable: true })
        try {
            await program.parseAsync(['node', 'test', 'token', 'set'])
        } finally {
            Object.defineProperty(process, 'stdin', {
                value: originalStdin,
                configurable: true,
            })
        }
        const store = createConfigTokenStore<Account>({ configPath: path, multiUser: true })
        expect((await store.active())?.token).toBe('paste-me')
    })

    it('token set rejects when stdin is a TTY', async () => {
        const program = build({ flat: true })
        const originalStdin = process.stdin
        const fakeTty = Object.assign(Readable.from([]), { isTTY: true })
        Object.defineProperty(process, 'stdin', { value: fakeTty, configurable: true })
        try {
            await expect(
                program.parseAsync(['node', 'test', 'token', 'set']),
            ).rejects.toMatchObject({ code: 'AUTH_INVALID_TOKEN' })
        } finally {
            Object.defineProperty(process, 'stdin', {
                value: originalStdin,
                configurable: true,
            })
        }
    })
})
