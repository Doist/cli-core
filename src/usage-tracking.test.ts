import { Command } from 'commander'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createUsageTracking } from './usage-tracking.js'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')

function setPlatform(platform: string): void {
    Object.defineProperty(process, 'platform', { value: platform, configurable: true })
}

// Every variable agent detection reads. Cleared before each test so the suite gives the same
// result in a person's terminal, in CI and when an agent runs it.
const AGENT_ENV = [
    'AI_AGENT',
    'ANTIGRAVITY_AGENT',
    'AUGMENT_AGENT',
    'CLAUDECODE',
    'CLAUDE_CODE',
    'CODEX_CI',
    'CODEX_SANDBOX',
    'CODEX_THREAD_ID',
    'COPILOT_ALLOW_ALL',
    'COPILOT_GITHUB_TOKEN',
    'COPILOT_MODEL',
    'CURSOR_AGENT',
    'CURSOR_EXTENSION_HOST_ROLE',
    'CURSOR_TRACE_ID',
    'GEMINI_CLI',
    'OPENCODE',
    'OPENCODE_CLIENT',
    'REPL_ID',
]

beforeEach(() => {
    for (const name of AGENT_ENV) vi.stubEnv(name, undefined)
})

afterEach(() => {
    if (originalPlatform) Object.defineProperty(process, 'platform', originalPlatform)
    vi.unstubAllEnvs()
})

function stubEnv(env: Record<string, string>): void {
    for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value)
}

function createTracking() {
    return createUsageTracking({ cliName: 'example-cli', version: '1.2.3' })
}

/** Builds `example <group> <sub>` and returns the leaf, as Commander hands it to a preAction hook. */
function leafCommand(...names: string[]): Command {
    let command = new Command('example')
    for (const name of names) command = command.command(name)
    return command
}

describe('createUsageTracking', () => {
    it('sends the CLI identity, OS, request, session, command and agent on every request', () => {
        setPlatform('linux')
        const usage = createTracking()
        usage.setCommand('today')

        const headers = usage.headers()

        expect(headers).toEqual({
            'User-Agent': 'example-cli/1.2.3',
            'doist-platform': 'cli',
            'doist-version': '1.2.3',
            'doist-os': 'linux',
            'request-id': expect.stringMatching(UUID),
            'session-id': expect.stringMatching(UUID),
            'cli-command': 'today',
            'cli-agent': 'none',
        })
    })

    it('gives every request its own request ID', () => {
        const usage = createTracking()

        expect(usage.headers()['request-id']).not.toBe(usage.headers()['request-id'])
    })

    it.each([
        ['darwin', 'macos'],
        ['linux', 'linux'],
        ['win32', 'windows'],
        ['freebsd', 'unknown'],
    ])('reports process.platform %s as doist-os %s', (platform, expected) => {
        setPlatform(platform)

        expect(createTracking().headers()['doist-os']).toBe(expected)
    })

    it('keeps one session ID for the life of a tracker', () => {
        const usage = createTracking()

        expect(usage.headers()['session-id']).toBe(usage.headers()['session-id'])
    })

    it('gives each tracker its own session ID', () => {
        expect(createTracking().headers()['session-id']).not.toBe(
            createTracking().headers()['session-id'],
        )
    })

    it('labels requests made before any command is set as unknown', () => {
        expect(createTracking().headers()['cli-command']).toBe('unknown')
    })

    describe('setCommand', () => {
        it.each([
            [['today'], 'today'],
            [['task', 'add'], 'task:add'],
            [['Thread', 'View'], 'thread:view'],
        ])('labels the Commander command %j (without the program name) as %s', (names, label) => {
            const usage = createTracking()
            usage.setCommand(leafCommand(...names))

            expect(usage.headers()['cli-command']).toBe(label)
        })

        it.each([
            ['task:view', 'task:view'],
            ['  Task View ', 'task:view'],
            ['postinstall:auth-migrate', 'postinstall:auth-migrate'],
        ])('normalises the label %j to %s', (input, label) => {
            const usage = createTracking()
            usage.setCommand(input)

            expect(usage.headers()['cli-command']).toBe(label)
        })

        it('labels a command that only has a name and a parent, without Commander', () => {
            const usage = createTracking()
            const program = { name: () => 'example', parent: null }
            const group = { name: () => 'task', parent: program }
            usage.setCommand({ name: () => 'add', parent: group })

            expect(usage.headers()['cli-command']).toBe('task:add')
        })

        it('replaces the previous command, as a routed command does', () => {
            const usage = createTracking()
            usage.setCommand('view')
            usage.setCommand('task:view')

            expect(usage.headers()['cli-command']).toBe('task:view')
        })

        it('goes back to unknown when cleared', () => {
            const usage = createTracking()
            usage.setCommand('today')
            usage.setCommand(undefined)

            expect(usage.headers()['cli-command']).toBe('unknown')
        })
    })

    it('lets one request name its own command without changing the active one', () => {
        const usage = createTracking()
        usage.setCommand('today')

        expect(usage.headers({ command: 'Postinstall Auth-Migrate' })['cli-command']).toBe(
            'postinstall:auth-migrate',
        )
        expect(usage.headers()['cli-command']).toBe('today')
    })

    describe('cli-agent', () => {
        it('reports none when no agent is detected', () => {
            expect(createTracking().headers()['cli-agent']).toBe('none')
        })

        it.each([
            [{ CLAUDECODE: '1' }, 'claude-code'],
            [{ CLAUDE_CODE: '1' }, 'claude-code'],
            [{ CODEX_SANDBOX: 'seatbelt' }, 'codex'],
            [{ CODEX_CI: '1' }, 'codex'],
            [{ CODEX_THREAD_ID: 'thread' }, 'codex'],
            [{ CURSOR_AGENT: '1' }, 'cursor'],
            [{ CURSOR_EXTENSION_HOST_ROLE: 'agent-exec' }, 'cursor'],
            [{ GEMINI_CLI: '1' }, 'gemini'],
            [{ OPENCODE: '1' }, 'opencode'],
            [{ OPENCODE_CLIENT: 'tui' }, 'opencode'],
            [{ ANTIGRAVITY_AGENT: '1' }, 'other'],
            [{ AUGMENT_AGENT: '1' }, 'other'],
        ])('reports %o as %s', (env, expected) => {
            stubEnv(env)

            expect(createTracking().headers()['cli-agent']).toBe(expected)
        })

        it.each([
            // What Claude Code sets: the name, then its version.
            ['claude-code_2-1-322_agent', 'claude-code'],
            ['codex', 'codex'],
            ['cursor-cli', 'cursor'],
            ['gemini-cli', 'gemini'],
            ['github-copilot-cli', 'copilot'],
            ['opencode', 'opencode'],
            [' Claude-Code ', 'claude-code'],
            ['devin@1', 'other'],
        ])('reports AI_AGENT=%s as %s', (name, expected) => {
            stubEnv({ AI_AGENT: name })

            expect(createTracking().headers()['cli-agent']).toBe(expected)
        })

        it('takes a named AI_AGENT over another agent marker', () => {
            stubEnv({ AI_AGENT: 'codex', CLAUDECODE: '1' })

            expect(createTracking().headers()['cli-agent']).toBe('codex')
        })

        it('falls back to an agent marker when AI_AGENT names an agent it does not know', () => {
            stubEnv({ AI_AGENT: 'my-harness', CLAUDECODE: '1' })

            expect(createTracking().headers()['cli-agent']).toBe('claude-code')
        })

        it('ignores a blank AI_AGENT', () => {
            stubEnv({ AI_AGENT: '  ' })

            expect(createTracking().headers()['cli-agent']).toBe('none')
        })

        it.each([
            [{ CURSOR_TRACE_ID: 'trace' }],
            [{ REPL_ID: 'replit' }],
            [{ COPILOT_MODEL: 'gpt-5' }],
            [{ COPILOT_ALLOW_ALL: 'true' }],
            [{ COPILOT_GITHUB_TOKEN: 'token' }],
            [{ CURSOR_EXTENSION_HOST_ROLE: 'user' }],
            [{ OPENCODE: '0' }],
        ])('does not count %o as an agent', (env) => {
            stubEnv(env)

            expect(createTracking().headers()['cli-agent']).toBe('none')
        })

        it('reads the environment once, when the tracker is created', () => {
            const usage = createTracking()
            stubEnv({ CLAUDECODE: '1' })

            expect(usage.headers()['cli-agent']).toBe('none')
        })
    })

    describe('mergeHeaders', () => {
        it.each([
            ['a plain object', { Authorization: 'Bearer token', Accept: 'application/json' }],
            [
                'a Headers instance',
                new Headers({ Authorization: 'Bearer token', Accept: 'application/json' }),
            ],
            [
                'header tuples',
                [
                    ['Authorization', 'Bearer token'],
                    ['Accept', 'application/json'],
                ] as [string, string][],
            ],
        ])('keeps the caller headers from %s alongside the usage headers', (_kind, init) => {
            setPlatform('darwin')
            const usage = createTracking()
            usage.setCommand('task:add')

            expect(usage.mergeHeaders(init)).toEqual({
                authorization: 'Bearer token',
                accept: 'application/json',
                'user-agent': 'example-cli/1.2.3',
                'doist-platform': 'cli',
                'doist-version': '1.2.3',
                'doist-os': 'macos',
                'request-id': expect.stringMatching(UUID),
                'session-id': expect.stringMatching(UUID),
                'cli-command': 'task:add',
                'cli-agent': 'none',
            })
        })

        it('overrides a caller header that names a usage header in any case', () => {
            const usage = createTracking()

            const merged = usage.mergeHeaders({ 'Doist-Platform': 'web', 'user-agent': 'node' })

            expect(merged['doist-platform']).toBe('cli')
            expect(merged['user-agent']).toBe('example-cli/1.2.3')
        })

        it('returns only the usage headers when there is nothing to merge', () => {
            const usage = createTracking()
            usage.setCommand('today')

            expect(Object.keys(usage.mergeHeaders()).sort()).toEqual([
                'cli-agent',
                'cli-command',
                'doist-os',
                'doist-platform',
                'doist-version',
                'request-id',
                'session-id',
                'user-agent',
            ])
        })

        it('applies a per-request command', () => {
            const usage = createTracking()
            usage.setCommand('today')

            expect(usage.mergeHeaders({}, { command: 'auth:login' })['cli-command']).toBe(
                'auth:login',
            )
        })
    })
})
