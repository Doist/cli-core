import chalk from 'chalk'
import { Command } from 'commander'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CliError } from '../errors.js'
import {
    compareVersions,
    isNewer,
    parseVersion,
    registerUpdateCommand,
    type UpdateCommandOptions,
} from './update.js'

vi.mock('node:child_process', () => ({
    spawn: vi.fn(),
}))

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

function createProgram(overrides: Partial<UpdateCommandOptions> = {}): Command {
    const program = new Command()
    program.name('td')
    program.exitOverride()
    registerUpdateCommand(program, { ...BASE_OPTIONS, ...overrides })
    return program
}

function mockFetchOk(version: string) {
    vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
            ok: true,
            json: () => Promise.resolve({ version }),
        }),
    )
}

function mockFetchHttp(status: number) {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status }))
}

function mockFetchNetwork(message: string) {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error(message)))
}

function mockSpawnSuccess() {
    mockSpawn.mockReturnValue({
        stderr: { on: vi.fn() },
        on: vi.fn((event: string, cb: (arg?: unknown) => void) => {
            if (event === 'close') cb(0)
        }),
    } as never)
}

function mockSpawnExit(exitCode: number, stderr = '') {
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

function mockSpawnEacces() {
    mockSpawn.mockReturnValue({
        stderr: { on: vi.fn() },
        on: vi.fn((event: string, cb: (arg?: unknown) => void) => {
            if (event === 'error') {
                cb(Object.assign(new Error('EACCES'), { code: 'EACCES' }))
            }
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

describe('parseVersion', () => {
    it('parses plain semver', () => {
        expect(parseVersion('1.2.3')).toEqual({
            major: 1,
            minor: 2,
            patch: 3,
            prerelease: undefined,
        })
    })

    it('strips leading v and captures prerelease', () => {
        expect(parseVersion('v1.2.3-next.4')).toEqual({
            major: 1,
            minor: 2,
            patch: 3,
            prerelease: 'next.4',
        })
    })
})

describe('compareVersions / isNewer', () => {
    it('compares core triplet', () => {
        expect(compareVersions('1.2.3', '1.2.4')).toBe(-1)
        expect(compareVersions('2.0.0', '1.99.99')).toBe(1)
        expect(compareVersions('1.0.0', '1.0.0')).toBe(0)
    })

    it('ranks pre-release below same-core release', () => {
        expect(compareVersions('1.0.0-next.1', '1.0.0')).toBe(-1)
        expect(compareVersions('1.0.0', '1.0.0-next.1')).toBe(1)
    })

    it('compares pre-releases numerically (next.10 > next.2)', () => {
        expect(compareVersions('1.0.0-next.2', '1.0.0-next.10')).toBe(-1)
        expect(isNewer('1.0.0-next.2', '1.0.0-next.10')).toBe(true)
    })
})

describe('update --channel', () => {
    it('reports stable when no config set', async () => {
        const program = createProgram()
        await program.parseAsync(['node', 'td', 'update', '--channel'])
        expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('stable'))
    })

    it('reports pre-release when configured', async () => {
        mockReadConfig.mockResolvedValue({ update_channel: 'pre-release' })
        const program = createProgram()
        await program.parseAsync(['node', 'td', 'update', '--channel'])
        expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('pre-release'))
    })

    it('does not fetch from the registry', async () => {
        const fetchMock = vi.fn()
        vi.stubGlobal('fetch', fetchMock)
        const program = createProgram()
        await program.parseAsync(['node', 'td', 'update', '--channel'])
        expect(fetchMock).not.toHaveBeenCalled()
    })

    it('emits { channel } envelope under --json', async () => {
        const program = createProgram()
        await program.parseAsync(['node', 'td', 'update', '--channel', '--json'])
        const payload = JSON.parse(consoleSpy.mock.calls[0][0] as string)
        expect(payload).toEqual({ channel: 'stable' })
    })

    it('errors when combined with --check', async () => {
        const program = createProgram()
        await expect(
            program.parseAsync(['node', 'td', 'update', '--check', '--channel']),
        ).rejects.toMatchObject({ code: 'INVALID_FLAGS' })
    })
})

describe('update --check', () => {
    it('reports update available without spawning install', async () => {
        mockFetchOk('99.99.99')
        const program = createProgram()
        await program.parseAsync(['node', 'td', 'update', '--check'])
        expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Update available'))
        expect(mockSpawn).not.toHaveBeenCalled()
    })

    it('reports up-to-date when versions match', async () => {
        mockFetchOk('1.0.0')
        const program = createProgram()
        await program.parseAsync(['node', 'td', 'update', '--check'])
        expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Already up to date'))
    })

    it('emits machine envelope under --json', async () => {
        mockFetchOk('99.99.99')
        const program = createProgram()
        await program.parseAsync(['node', 'td', 'update', '--check', '--json'])
        const payload = JSON.parse(consoleSpy.mock.calls[0][0] as string)
        expect(payload).toEqual({
            currentVersion: '1.0.0',
            latestVersion: '99.99.99',
            channel: 'stable',
            updateAvailable: true,
        })
    })

    it('emits NDJSON envelope under --ndjson', async () => {
        mockFetchOk('99.99.99')
        const program = createProgram()
        await program.parseAsync(['node', 'td', 'update', '--check', '--ndjson'])
        const line = (consoleSpy.mock.calls[0][0] as string).trim()
        expect(JSON.parse(line)).toEqual({
            currentVersion: '1.0.0',
            latestVersion: '99.99.99',
            channel: 'stable',
            updateAvailable: true,
        })
    })

    it('respects pre-release channel for the registry URL', async () => {
        mockReadConfig.mockResolvedValue({ update_channel: 'pre-release' })
        mockFetchOk('1.36.0-next.1')
        const program = createProgram()
        await program.parseAsync(['node', 'td', 'update', '--check'])
        expect(fetch).toHaveBeenCalledWith('https://registry.npmjs.org/@doist/todoist-cli/next')
    })
})

describe('update install flow', () => {
    it('spawns npm install -g for stable', async () => {
        mockFetchOk('99.99.99')
        mockSpawnSuccess()
        const program = createProgram()
        await program.parseAsync(['node', 'td', 'update'])
        expect(mockSpawn).toHaveBeenCalledWith(
            'npm',
            ['install', '-g', '@doist/todoist-cli@latest'],
            { stdio: 'pipe' },
        )
    })

    it('uses pnpm add when npm_execpath indicates pnpm', async () => {
        mockFetchOk('99.99.99')
        mockSpawnSuccess()
        vi.stubEnv('npm_execpath', '/usr/local/lib/node_modules/pnpm/bin/pnpm.cjs')
        const program = createProgram()
        await program.parseAsync(['node', 'td', 'update'])
        expect(mockSpawn).toHaveBeenCalledWith('pnpm', ['add', '-g', '@doist/todoist-cli@latest'], {
            stdio: 'pipe',
        })
    })

    it('installs with @next tag on the pre-release channel', async () => {
        mockReadConfig.mockResolvedValue({ update_channel: 'pre-release' })
        mockFetchOk('1.36.0-next.1')
        mockSpawnSuccess()
        const program = createProgram()
        await program.parseAsync(['node', 'td', 'update'])
        expect(mockSpawn).toHaveBeenCalledWith(
            'npm',
            ['install', '-g', '@doist/todoist-cli@next'],
            { stdio: 'pipe' },
        )
    })

    it('still proceeds when registry version is older (downgrade)', async () => {
        mockReadConfig.mockResolvedValue({ update_channel: 'pre-release' })
        mockFetchOk('1.0.0-next.1')
        mockSpawnSuccess()
        const program = createProgram()
        await program.parseAsync(['node', 'td', 'update'])
        expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Downgrade available'))
        expect(mockSpawn).toHaveBeenCalled()
    })

    it('skips install when versions match and emits up-to-date', async () => {
        mockFetchOk('1.0.0')
        const program = createProgram()
        await program.parseAsync(['node', 'td', 'update'])
        expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Already up to date'))
        expect(mockSpawn).not.toHaveBeenCalled()
    })

    it('shows the changelog tip on stable success', async () => {
        mockFetchOk('99.99.99')
        mockSpawnSuccess()
        const program = createProgram()
        await program.parseAsync(['node', 'td', 'update'])
        expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('td changelog'))
    })

    it('omits the changelog tip on pre-release success', async () => {
        mockReadConfig.mockResolvedValue({ update_channel: 'pre-release' })
        mockFetchOk('1.36.0-next.1')
        mockSpawnSuccess()
        const program = createProgram()
        await program.parseAsync(['node', 'td', 'update'])
        expect(consoleSpy).not.toHaveBeenCalledWith(expect.stringContaining('td changelog'))
    })

    it('emits installed envelope under --json on success', async () => {
        mockFetchOk('99.99.99')
        mockSpawnSuccess()
        const program = createProgram()
        await program.parseAsync(['node', 'td', 'update', '--json'])
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
    it('throws UPDATE_CHECK_FAILED on registry HTTP error', async () => {
        mockFetchHttp(503)
        const program = createProgram()
        await expect(program.parseAsync(['node', 'td', 'update'])).rejects.toMatchObject({
            code: 'UPDATE_CHECK_FAILED',
        })
    })

    it('throws UPDATE_CHECK_FAILED on network error', async () => {
        mockFetchNetwork('getaddrinfo ENOTFOUND registry.npmjs.org')
        const program = createProgram()
        await expect(program.parseAsync(['node', 'td', 'update'])).rejects.toMatchObject({
            code: 'UPDATE_CHECK_FAILED',
        })
    })

    it('throws UPDATE_INSTALL_FAILED with sudo hint on EACCES', async () => {
        mockFetchOk('99.99.99')
        mockSpawnEacces()
        const program = createProgram()
        const promise = program.parseAsync(['node', 'td', 'update'])
        await expect(promise).rejects.toBeInstanceOf(CliError)
        await promise.catch((error: CliError) => {
            expect(error.code).toBe('UPDATE_INSTALL_FAILED')
            expect(error.message).toContain('Permission denied')
            expect(error.hints?.[0]).toContain('sudo')
        })
    })

    it('throws UPDATE_INSTALL_FAILED on non-zero exit', async () => {
        mockFetchOk('99.99.99')
        mockSpawnExit(1, 'npm ERR! something broke')
        const program = createProgram()
        const promise = program.parseAsync(['node', 'td', 'update'])
        await expect(promise).rejects.toBeInstanceOf(CliError)
        await promise.catch((error: CliError) => {
            expect(error.code).toBe('UPDATE_INSTALL_FAILED')
            expect(error.message).toContain('exited with code 1')
            expect(error.hints?.[0]).toContain('npm ERR! something broke')
        })
    })
})

describe('update switch', () => {
    it('persists stable', async () => {
        const program = createProgram()
        await program.parseAsync(['node', 'td', 'update', 'switch', '--stable'])
        expect(mockUpdateConfig).toHaveBeenCalledWith('/fake/config.json', {
            update_channel: 'stable',
        })
        expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('stable'))
    })

    it('persists pre-release with guidance', async () => {
        const program = createProgram()
        await program.parseAsync(['node', 'td', 'update', 'switch', '--pre-release'])
        expect(mockUpdateConfig).toHaveBeenCalledWith('/fake/config.json', {
            update_channel: 'pre-release',
        })
        expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Remember to switch back'))
        // Hint uses the consumer's program name.
        expect(consoleSpy).toHaveBeenCalledWith(
            expect.stringContaining('td update switch --stable'),
        )
    })

    it('emits { channel } envelope under --json', async () => {
        const program = createProgram()
        await program.parseAsync(['node', 'td', 'update', 'switch', '--stable', '--json'])
        const payload = JSON.parse(consoleSpy.mock.calls[0][0] as string)
        expect(payload).toEqual({ channel: 'stable' })
    })

    it('throws INVALID_FLAGS when both flags set', async () => {
        const program = createProgram()
        await expect(
            program.parseAsync(['node', 'td', 'update', 'switch', '--stable', '--pre-release']),
        ).rejects.toMatchObject({ code: 'INVALID_FLAGS' })
    })

    it('throws INVALID_FLAGS when no flag set', async () => {
        const program = createProgram()
        await expect(program.parseAsync(['node', 'td', 'update', 'switch'])).rejects.toMatchObject({
            code: 'INVALID_FLAGS',
        })
    })

    it('translates a broken config file to a CONFIG_* CliError', async () => {
        mockReadConfigStrict.mockResolvedValueOnce({
            state: 'invalid-json',
            error: new SyntaxError('Unexpected token'),
        })
        const program = createProgram()
        const promise = program.parseAsync(['node', 'td', 'update', 'switch', '--stable'])
        await expect(promise).rejects.toBeInstanceOf(CliError)
        await promise.catch((error: CliError) => {
            expect(error.code).toBe('CONFIG_INVALID_JSON')
        })
        expect(mockUpdateConfig).not.toHaveBeenCalled()
    })

    it('preserves existing config keys (delegates to updateConfig merge)', async () => {
        mockReadConfigStrict.mockResolvedValueOnce({
            state: 'present',
            config: { auth_mode: 'read-write' },
        })
        const program = createProgram()
        await program.parseAsync(['node', 'td', 'update', 'switch', '--stable'])
        // updateConfig (real) does the merge; we assert we delegated to it with
        // just the channel patch, matching the documented contract.
        expect(mockUpdateConfig).toHaveBeenCalledWith('/fake/config.json', {
            update_channel: 'stable',
        })
    })
})
