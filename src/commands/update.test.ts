import chalk from 'chalk'
import { Command } from 'commander'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CliError } from '../errors.js'
import type { SpinnerOptions } from '../spinner.js'
import {
    compareVersions,
    isNewer,
    parseVersion,
    registerUpdateCommand,
    type UpdateCommandOptions,
} from './update.js'

vi.mock('node:child_process', () => ({ spawn: vi.fn() }))

vi.mock('../config.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../config.js')>()
    return {
        ...actual,
        readConfigOrThrow: vi.fn().mockResolvedValue({}),
        updateConfigOrThrow: vi.fn().mockResolvedValue(undefined),
    }
})

const { spawn } = await import('node:child_process')
const config = await import('../config.js')
const mockSpawn = vi.mocked(spawn)
const mockReadConfigOrThrow = vi.mocked(config.readConfigOrThrow)
const mockUpdateConfigOrThrow = vi.mocked(config.updateConfigOrThrow)

const BASE_OPTIONS: UpdateCommandOptions = {
    packageName: '@doist/todoist-cli',
    currentVersion: '1.0.0',
    configPath: '/fake/config.json',
    changelogCommandName: 'td changelog',
}

function createProgram(): Command {
    const program = new Command()
    program.name('td').exitOverride()
    registerUpdateCommand(program, BASE_OPTIONS)
    return program
}

function mockFetchOk(version: string) {
    vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ version }) }),
    )
}

function mockSpawnExit(exitCode = 0, stderr = '') {
    mockSpawn.mockReturnValue({
        stderr: {
            on: vi.fn((event: string, cb: (chunk: Buffer) => void) => {
                if (event === 'data' && stderr) cb(Buffer.from(stderr))
            }),
        },
        on: vi.fn((event: string, cb: (arg?: unknown) => void) => {
            if (event === 'close') cb(exitCode)
        }),
    } as never)
}

function mockSpawnError(error: Error) {
    mockSpawn.mockReturnValue({
        stderr: { on: vi.fn() },
        on: vi.fn((event: string, cb: (arg?: unknown) => void) => {
            if (event === 'error') cb(error)
        }),
    } as never)
}

let consoleSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
    chalk.level = 0
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    mockReadConfigOrThrow.mockReset().mockResolvedValue({})
    mockUpdateConfigOrThrow.mockReset().mockResolvedValue(undefined)
    mockSpawn.mockClear()
})

afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
})

describe('semver helpers', () => {
    it('parseVersion handles plain, leading-v, and prerelease', () => {
        expect(parseVersion('1.2.3')).toEqual({
            major: 1,
            minor: 2,
            patch: 3,
            prerelease: undefined,
        })
        expect(parseVersion('v1.2.3-next.4')).toEqual({
            major: 1,
            minor: 2,
            patch: 3,
            prerelease: 'next.4',
        })
    })

    it('compareVersions / isNewer rank core, then prerelease below release, then numerically', () => {
        // Core triplet.
        expect(compareVersions('1.2.3', '1.2.4')).toBe(-1)
        expect(compareVersions('2.0.0', '1.99.99')).toBe(1)
        expect(compareVersions('1.0.0', '1.0.0')).toBe(0)
        // Pre-release ranks below same-core release.
        expect(compareVersions('1.0.0-next.1', '1.0.0')).toBe(-1)
        expect(compareVersions('1.0.0', '1.0.0-next.1')).toBe(1)
        // Numeric prerelease ordering (next.10 > next.2).
        expect(compareVersions('1.0.0-next.2', '1.0.0-next.10')).toBe(-1)
        expect(isNewer('1.0.0-next.2', '1.0.0-next.10')).toBe(true)
    })
})

describe('update --channel', () => {
    it.each([
        ['stable', undefined],
        ['pre-release', 'pre-release' as const],
    ])('reports %s without hitting the registry', async (expected, configured) => {
        if (configured) mockReadConfigOrThrow.mockResolvedValue({ update_channel: configured })
        const fetchMock = vi.fn()
        vi.stubGlobal('fetch', fetchMock)
        await createProgram().parseAsync(['node', 'td', 'update', '--channel'])
        expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining(expected))
        expect(fetchMock).not.toHaveBeenCalled()
    })

    it('emits { channel } envelope under --json', async () => {
        await createProgram().parseAsync(['node', 'td', 'update', '--channel', '--json'])
        expect(JSON.parse(consoleSpy.mock.calls[0][0] as string)).toEqual({ channel: 'stable' })
    })
})

describe('update --check', () => {
    it.each([
        ['update available', '99.99.99', /Update available/],
        ['already up to date', '1.0.0', /Already up to date/],
    ])('reports %s without spawning install', async (_, version, pattern) => {
        mockFetchOk(version)
        await createProgram().parseAsync(['node', 'td', 'update', '--check'])
        expect(consoleSpy).toHaveBeenCalledWith(expect.stringMatching(pattern))
        expect(mockSpawn).not.toHaveBeenCalled()
    })

    it.each([
        ['--json', (s: string) => JSON.parse(s)],
        ['--ndjson', (s: string) => JSON.parse(s.trim())],
    ])('emits machine envelope under %s', async (flag, parse) => {
        mockFetchOk('99.99.99')
        await createProgram().parseAsync(['node', 'td', 'update', '--check', flag])
        expect(parse(consoleSpy.mock.calls[0][0] as string)).toEqual({
            currentVersion: '1.0.0',
            latestVersion: '99.99.99',
            channel: 'stable',
            updateAvailable: true,
        })
    })

    it('respects pre-release channel for the registry URL', async () => {
        mockReadConfigOrThrow.mockResolvedValue({ update_channel: 'pre-release' })
        mockFetchOk('1.36.0-next.1')
        await createProgram().parseAsync(['node', 'td', 'update', '--check'])
        expect(fetch).toHaveBeenCalledWith('https://registry.npmjs.org/@doist/todoist-cli/next')
    })
})

describe('update install flow', () => {
    type SpawnCase = readonly [
        label: string,
        channel: 'pre-release' | undefined,
        execpath: string | undefined,
        pm: string,
        args: string[],
    ]
    const cases: SpawnCase[] = [
        [
            'stable + npm',
            undefined,
            undefined,
            'npm',
            ['install', '-g', '@doist/todoist-cli@latest'],
        ],
        [
            'stable + pnpm (via npm_execpath)',
            undefined,
            '/usr/local/lib/node_modules/pnpm/bin/pnpm.cjs',
            'pnpm',
            ['add', '-g', '@doist/todoist-cli@latest'],
        ],
        [
            'pre-release + npm',
            'pre-release',
            undefined,
            'npm',
            ['install', '-g', '@doist/todoist-cli@next'],
        ],
    ]

    it.each(cases)(
        'spawns the right install command (%s)',
        async (_, channel, execpath, pm, args) => {
            if (channel) mockReadConfigOrThrow.mockResolvedValue({ update_channel: channel })
            if (execpath) vi.stubEnv('npm_execpath', execpath)
            mockFetchOk('99.99.99')
            mockSpawnExit()
            await createProgram().parseAsync(['node', 'td', 'update'])
            expect(mockSpawn).toHaveBeenCalledWith(pm, args, {
                stdio: ['ignore', 'ignore', 'pipe'],
                shell: process.platform === 'win32',
            })
        },
    )

    it('warns and still installs when registry version is older (downgrade)', async () => {
        mockReadConfigOrThrow.mockResolvedValue({ update_channel: 'pre-release' })
        mockFetchOk('1.0.0-next.1')
        mockSpawnExit()
        await createProgram().parseAsync(['node', 'td', 'update'])
        expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Downgrade available'))
        expect(mockSpawn).toHaveBeenCalled()
    })

    it('skips install when versions match', async () => {
        mockFetchOk('1.0.0')
        await createProgram().parseAsync(['node', 'td', 'update'])
        expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Already up to date'))
        expect(mockSpawn).not.toHaveBeenCalled()
    })

    it.each([
        ['stable', undefined, true],
        ['pre-release', 'pre-release' as const, false],
    ])('shows the changelog tip only on %s success', async (_, channel, expectsTip) => {
        if (channel) mockReadConfigOrThrow.mockResolvedValue({ update_channel: channel })
        mockFetchOk('99.99.99')
        mockSpawnExit()
        await createProgram().parseAsync(['node', 'td', 'update'])
        const matcher = expect.stringContaining('td changelog')
        if (expectsTip) expect(consoleSpy).toHaveBeenCalledWith(matcher)
        else expect(consoleSpy).not.toHaveBeenCalledWith(matcher)
    })

    it('emits installed envelope under --json on success', async () => {
        mockFetchOk('99.99.99')
        mockSpawnExit()
        await createProgram().parseAsync(['node', 'td', 'update', '--json'])
        const payloads = consoleSpy.mock.calls.map((call: unknown[]) =>
            JSON.parse(call[0] as string),
        )
        expect(payloads).toContainEqual({
            currentVersion: '1.0.0',
            latestVersion: '99.99.99',
            channel: 'stable',
            installed: true,
        })
    })
})

describe('update error paths', () => {
    it.each([
        [
            'HTTP error',
            () => vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 503 })),
        ],
        [
            'network error',
            () => vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ENOTFOUND'))),
        ],
    ])('throws UPDATE_CHECK_FAILED on registry %s', async (_, setup) => {
        setup()
        await expect(createProgram().parseAsync(['node', 'td', 'update'])).rejects.toMatchObject({
            code: 'UPDATE_CHECK_FAILED',
        })
    })

    it('throws UPDATE_INSTALL_FAILED with sudo hint on EACCES', async () => {
        mockFetchOk('99.99.99')
        mockSpawnError(Object.assign(new Error('EACCES'), { code: 'EACCES' }))
        await expect(createProgram().parseAsync(['node', 'td', 'update'])).rejects.toMatchObject({
            code: 'UPDATE_INSTALL_FAILED',
            message: expect.stringContaining('Permission denied'),
            hints: [expect.stringContaining('sudo')],
        })
    })

    it('throws UPDATE_INSTALL_FAILED on non-zero exit (stderr in hints)', async () => {
        mockFetchOk('99.99.99')
        mockSpawnExit(1, 'npm ERR! something broke')
        await expect(createProgram().parseAsync(['node', 'td', 'update'])).rejects.toMatchObject({
            code: 'UPDATE_INSTALL_FAILED',
            message: expect.stringContaining('exited with code 1'),
            hints: [expect.stringContaining('npm ERR! something broke')],
        })
    })
})

describe('update switch', () => {
    it.each([
        ['stable', '--stable', false],
        ['pre-release', '--pre-release', true],
    ])('persists %s', async (channel, flag, expectsGuidance) => {
        await createProgram().parseAsync(['node', 'td', 'update', 'switch', flag])
        expect(mockUpdateConfigOrThrow).toHaveBeenCalledWith('/fake/config.json', {
            update_channel: channel,
        })
        if (expectsGuidance) {
            expect(consoleSpy).toHaveBeenCalledWith(
                expect.stringContaining('Remember to switch back'),
            )
            // Hint uses the consumer's program name.
            expect(consoleSpy).toHaveBeenCalledWith(
                expect.stringContaining('td update switch --stable'),
            )
        }
    })

    it.each([
        [
            'child-parsed: --json after switch',
            ['node', 'td', 'update', 'switch', '--stable', '--json'],
        ],
        [
            'parent-parsed: --json before switch',
            ['node', 'td', 'update', '--json', 'switch', '--stable'],
        ],
    ])('emits { channel } envelope when %s', async (_, argv) => {
        await createProgram().parseAsync(argv)
        expect(JSON.parse(consoleSpy.mock.calls[0][0] as string)).toEqual({ channel: 'stable' })
    })

    it.each([
        ['switch with both flags', ['node', 'td', 'update', 'switch', '--stable', '--pre-release']],
        ['switch with neither flag', ['node', 'td', 'update', 'switch']],
        [
            'parent update with --check + --channel',
            ['node', 'td', 'update', '--check', '--channel'],
        ],
    ])('throws INVALID_FLAGS on %s', async (_, argv) => {
        await expect(createProgram().parseAsync(argv)).rejects.toMatchObject({
            code: 'INVALID_FLAGS',
        })
    })

    it('surfaces broken-config CliErrors thrown by updateConfigOrThrow', async () => {
        // updateConfigOrThrow already maps broken-config states; we just
        // verify the error propagates verbatim.
        mockUpdateConfigOrThrow.mockRejectedValueOnce(
            new CliError('CONFIG_INVALID_JSON', 'Cannot update config at /fake/config.json: bad'),
        )
        await expect(
            createProgram().parseAsync(['node', 'td', 'update', 'switch', '--stable']),
        ).rejects.toMatchObject({ code: 'CONFIG_INVALID_JSON' })
    })
})

describe('parseVersion edge cases', () => {
    it('strips +build metadata per semver §10', () => {
        expect(parseVersion('1.2.3+build.5')).toEqual({
            major: 1,
            minor: 2,
            patch: 3,
            prerelease: undefined,
        })
        expect(parseVersion('1.2.3-next.4+build.5')).toEqual({
            major: 1,
            minor: 2,
            patch: 3,
            prerelease: 'next.4',
        })
    })

    it('throws on inputs without a numeric major.minor.patch', () => {
        expect(() => parseVersion('not-a-version')).toThrow(/Invalid version string/)
        expect(() => parseVersion('1.2')).toThrow(/Invalid version string/)
    })
})

describe('getConfiguredUpdateChannel', () => {
    it('throws INVALID_UPDATE_CHANNEL on an unrecognised channel value in config', async () => {
        // The lenient parser would have silently fallen back to 'stable' here;
        // strict validation surfaces the misconfig instead.
        mockReadConfigOrThrow.mockResolvedValue({
            update_channel: 'canary',
        } as Record<string, unknown>)
        await expect(
            createProgram().parseAsync(['node', 'td', 'update', '--channel']),
        ).rejects.toMatchObject({ code: 'INVALID_UPDATE_CHANNEL' })
    })
})

describe('update --check downgrade reporting', () => {
    it('reports Downgrade available when current > latest (no install)', async () => {
        // currentVersion is BASE_OPTIONS.currentVersion = '1.0.0'; registry
        // returning '0.9.0' is a strict downgrade.
        mockFetchOk('0.9.0')
        await createProgram().parseAsync(['node', 'td', 'update', '--check'])
        expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Downgrade available'))
        expect(mockSpawn).not.toHaveBeenCalled()
    })
})

describe('withSpinner threading', () => {
    it('wraps both fetch and install ops with the supplied spinner', async () => {
        mockFetchOk('99.99.99')
        mockSpawnExit()
        // vi.fn loses the generic in `WithSpinner`; cast at the call site.
        const withSpinner = vi.fn((_opts: SpinnerOptions, op: () => Promise<unknown>) => op())
        const program = new Command()
        program.name('td').exitOverride()
        registerUpdateCommand(program, {
            ...BASE_OPTIONS,
            withSpinner: withSpinner as unknown as UpdateCommandOptions['withSpinner'],
        })
        await program.parseAsync(['node', 'td', 'update'])
        expect(withSpinner).toHaveBeenCalledWith(
            expect.objectContaining({
                text: expect.stringContaining('Checking for updates'),
                color: 'blue',
            }),
            expect.any(Function),
        )
        expect(withSpinner).toHaveBeenCalledWith(
            expect.objectContaining({
                text: expect.stringContaining('Updating to v99.99.99'),
                color: 'blue',
            }),
            expect.any(Function),
        )
    })
})
