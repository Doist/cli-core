import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Command } from 'commander'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createConfigTokenStore } from '../store/config.js'
import type { AuthProvider } from '../types.js'
import { registerAuthCommand } from './register.js'

type Account = { id: string; label?: string; email: string }

let dir: string
let path: string
let originalLog: typeof console.log

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cli-core-register-'))
    path = join(dir, 'config.json')
    originalLog = console.log
    console.log = () => undefined
})

afterEach(async () => {
    console.log = originalLog
    await rm(dir, { recursive: true, force: true })
})

function fakeProvider(): AuthProvider<Account> {
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
            return { id: '1', email: 'a@b' }
        },
    }
}

/**
 * Wrap a provider so we can capture the runtime-assigned redirectUri and
 * use it to drive the callback from `openBrowser`. The wrapped `authorize`
 * is reapplied after the spread so a caller-supplied override still gets
 * the redirectUri capture.
 */
function instrument(provider: AuthProvider<Account>): {
    provider: AuthProvider<Account>
    getRedirect: () => string
} {
    let redirectUri = ''
    const inner = provider.authorize
    const { authorize: _drop, ...rest } = provider
    void _drop
    return {
        provider: {
            ...rest,
            async authorize(input) {
                redirectUri = input.redirectUri
                return inner(input)
            },
        },
        getRedirect: () => redirectUri,
    }
}

type BuildOptions = {
    flat?: boolean
    commandName?: string
    loginFlags?: Parameters<typeof registerAuthCommand>[1]['loginFlags']
    resolveScopes?: Parameters<typeof registerAuthCommand>[1]['resolveScopes']
    provider?: AuthProvider<Account>
    callbackEnvVar?: string
    callbackFlagSpec?: string
    openBrowser?: (url: string) => Promise<void>
}

function build(opts: BuildOptions = {}): Command {
    const program = new Command()
    program.exitOverride()
    const store = createConfigTokenStore<Account>({ configPath: path })
    registerAuthCommand<Account>(program, {
        displayName: 'Test',
        provider: opts.provider ?? fakeProvider(),
        store,
        resolveScopes: opts.resolveScopes ?? (() => ['read']),
        callbackPort: {
            preferred: 0,
            envVar: opts.callbackEnvVar,
            flagSpec: opts.callbackFlagSpec,
        },
        renderSuccess: () => '',
        renderError: () => '',
        flat: opts.flat,
        commandName: opts.commandName,
        loginFlags: opts.loginFlags,
        openBrowser: opts.openBrowser,
    })
    return program
}

describe('registerAuthCommand', () => {
    it('nests login under `auth` by default; flat=true puts it at the top level', () => {
        const nested = build()
        expect(nested.commands.find((c) => c.name() === 'auth')).toBeDefined()
        expect(
            nested.commands.find((c) => c.name() === 'auth')?.commands.map((c) => c.name()),
        ).toContain('login')

        const flat = build({ flat: true })
        expect(flat.commands.find((c) => c.name() === 'login')).toBeDefined()
    })

    it('drives the OAuth flow end-to-end via Commander', async () => {
        const { provider, getRedirect } = instrument(fakeProvider())
        const openBrowser = vi.fn(async (url: string) => {
            const state = new URL(url).searchParams.get('state') ?? ''
            await fetch(`${getRedirect()}?code=abc&state=${state}`)
        })
        const program = build({ flat: true, provider, openBrowser })
        await program.parseAsync(['node', 'test', 'login'])
        const store = createConfigTokenStore<Account>({ configPath: path })
        expect((await store.active())?.token).toBe('tok-1')
    })

    it('loginFlags parsed values reach resolveScopes via the flags bag', async () => {
        const resolveScopes = vi.fn(({ flags }) => {
            expect(flags.additionalScopes).toEqual(['app-management', 'backups'])
            return ['data:read_write']
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
                seenPorts.push(Number(new URL(getRedirect()).port))
                const state = new URL(url).searchParams.get('state') ?? ''
                await fetch(`${getRedirect()}?code=abc&state=${state}`)
            },
        })
        try {
            await program.parseAsync(['node', 'test', 'login', '--callback-port', '0'])
            // CLI flag was 0 (OS-assigned); env was 40001. Env-winning behaviour
            // would have bound 40001.
            expect(seenPorts[0]).not.toBe(40001)
        } finally {
            delete process.env.TEST_CB_PORT
        }
    })

    it.each([
        ['foo', '--callback-port'],
        ['70000', '--callback-port'],
        ['1.5', '--callback-port'],
        ['123abc', '--callback-port'],
    ])('rejects --callback-port=%s with AUTH_PORT_BIND_FAILED', async (value) => {
        const program = build({ flat: true })
        await expect(
            program.parseAsync(['node', 'test', 'login', '--callback-port', value]),
        ).rejects.toMatchObject({ code: 'AUTH_PORT_BIND_FAILED' })
    })

    it('rejects malformed env-var port (validation deferred to action time, not registration)', async () => {
        process.env.TEST_CB_PORT = '123abc'
        // Registration must NOT throw — defers validation to the login action.
        const program = build({ flat: true, callbackEnvVar: 'TEST_CB_PORT' })
        try {
            await expect(program.parseAsync(['node', 'test', 'login'])).rejects.toMatchObject({
                code: 'AUTH_PORT_BIND_FAILED',
            })
        } finally {
            delete process.env.TEST_CB_PORT
        }
    })

    it('honours a custom flagSpec long name (strict-integer attribute mapping)', async () => {
        const { provider, getRedirect } = instrument(fakeProvider())
        const program = build({
            flat: true,
            provider,
            callbackFlagSpec: '--oauth-port <port>',
            openBrowser: async (url) => {
                const state = new URL(url).searchParams.get('state') ?? ''
                await fetch(`${getRedirect()}?code=abc&state=${state}`)
            },
        })
        // The renamed flag must reach the action handler — if attribute-name
        // derivation regressed, the bound port would silently fall back to the
        // preferred port instead of using --oauth-port=0.
        await program.parseAsync(['node', 'test', 'login', '--oauth-port', '0'])
    })
})
