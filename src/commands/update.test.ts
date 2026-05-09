import chalk from 'chalk'
import { Command } from 'commander'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
        readConfig: vi.fn().mockResolvedValue({}),
        readConfigStrict: vi.fn().mockResolvedValue({ state: 'missing' }),
        updateConfig: vi.fn().mockResolvedValue(undefined),
    }
})

const { spawn } = await import('node:child_process')
const config = await import('../config.js')
const mockSpawn = vi.mocked(spawn)
const mockReadConfig = vi.mocked(config.readConfig)
const mockReadConfigStrict = vi.mocked(config.readConfigStrict)
const mockUpdateConfig = vi.mocked(config.updateConfig)

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
    mockReadConfig.mockReset().mockResolvedValue({})
    mockReadConfigStrict.mockReset().mockResolvedValue({ state: 'missing' })
    mockUpdateConfig.mockReset().mockResolvedValue(undefined)
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
        if (configured) mockReadConfig.mockResolvedValue({ update_channel: configured })
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
        mockReadConfig.mockResolvedValue({ update_channel: 'pre-release' })
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
            if (channel) mockReadConfig.mockResolvedValue({ update_channel: channel })
            if (execpath) vi.stubEnv('npm_execpath', execpath)
            mockFetchOk('99.99.99')
            mockSpawnExit()
            await createProgram().parseAsync(['node', 'td', 'update'])
            expect(mockSpawn).toHaveBeenCalledWith(pm, args, { stdio: 'pipe' })
        },
    )

    it('warns and still installs when registry version is older (downgrade)', async () => {
        mockReadConfig.mockResolvedValue({ update_channel: 'pre-release' })
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
        if (channel) mockReadConfig.mockResolvedValue({ update_channel: channel })
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
        expect(mockUpdateConfig).toHaveBeenCalledWith('/fake/config.json', {
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

    it('emits { channel } envelope under --json', async () => {
        await createProgram().parseAsync(['node', 'td', 'update', 'switch', '--stable', '--json'])
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

    it('translates a broken config file to a CONFIG_* CliError', async () => {
        mockReadConfigStrict.mockResolvedValueOnce({
            state: 'invalid-json',
            error: new SyntaxError('Unexpected token'),
        })
        await expect(
            createProgram().parseAsync(['node', 'td', 'update', 'switch', '--stable']),
        ).rejects.toMatchObject({ code: 'CONFIG_INVALID_JSON' })
        expect(mockUpdateConfig).not.toHaveBeenCalled()
    })

    it('delegates the merge to updateConfig (preserves sibling keys)', async () => {
        mockReadConfigStrict.mockResolvedValueOnce({
            state: 'present',
            config: { auth_mode: 'read-write' },
        })
        await createProgram().parseAsync(['node', 'td', 'update', 'switch', '--stable'])
        expect(mockUpdateConfig).toHaveBeenCalledWith('/fake/config.json', {
            update_channel: 'stable',
        })
    })
})
