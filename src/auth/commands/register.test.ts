import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Command } from 'commander'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

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

function fakeProvider(): AuthProvider<Account> {
    return {
        async authorize() {
            throw new Error('not used in these tests')
        },
        async exchangeCode() {
            throw new Error('not used in these tests')
        },
        async validateToken({ token }) {
            return { id: '1', label: token.slice(0, 4), email: 'a@b' }
        },
        async acceptPastedToken({ token }) {
            return { id: '1', label: token.slice(0, 4), email: 'a@b' }
        },
    }
}

function build(
    opts: {
        flat?: boolean
        commandName?: string
        loginFlags?: Parameters<typeof registerAuthCommand>[1]['loginFlags']
    } = {},
): Command {
    const program = new Command()
    program.exitOverride()
    const store = createConfigTokenStore<Account>({ configPath: path, multiUser: true })
    registerAuthCommand<Account>(program, {
        appName: 'test',
        displayName: 'Test',
        provider: fakeProvider(),
        store,
        resolveScopes: () => ['read'],
        callbackPort: { preferred: 12345 },
        renderSuccess: () => '',
        renderError: () => '',
        flat: opts.flat,
        commandName: opts.commandName,
        loginFlags: opts.loginFlags,
    })
    return program
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

    it('login --token routes through provider.acceptPastedToken end-to-end', async () => {
        const program = build({ flat: true })
        await program.parseAsync(['node', 'test', 'login', '--token', 'paste-me'])
        const store = createConfigTokenStore<Account>({ configPath: path, multiUser: true })
        const active = await store.active()
        expect(active?.token).toBe('paste-me')
        expect(active?.account.label).toBe('past')
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
        const program = build({ flat: true })
        await program.parseAsync(['node', 'test', 'login', '--token', 'paste-me'])
        await program.parseAsync(['node', 'test', 'logout', '--all', '--json'])
        const last = JSON.parse(logs[logs.length - 1]) as { cleared: string }
        expect(last.cleared).toBe('all')
    })

    it('attaches CLI-specific loginFlags and exposes them under their key', async () => {
        const program = build({
            flat: true,
            loginFlags: [
                {
                    flags: '--additional-scopes <list>',
                    description: 'Extra scopes',
                    key: 'additionalScopes',
                    parse: (raw) => raw.split(','),
                },
            ],
        })
        const loginCmd = program.commands.find((c) => c.name() === 'login')
        const opt = loginCmd?.options.find((o) => o.long === '--additional-scopes')
        expect(opt).toBeDefined()
    })

    it('token (no subcommand) prints the active token', async () => {
        const program = build({ flat: true })
        await program.parseAsync(['node', 'test', 'login', '--token', 'tok-xyz'])
        logs.length = 0
        await program.parseAsync(['node', 'test', 'token'])
        expect(logs[0]).toBe('tok-xyz')
    })

    it('token set <value> persists via the provider', async () => {
        const program = build({ flat: true })
        await program.parseAsync(['node', 'test', 'token', 'set', 'tok-abc'])
        const store = createConfigTokenStore<Account>({ configPath: path, multiUser: true })
        expect((await store.active())?.token).toBe('tok-abc')
    })
})
