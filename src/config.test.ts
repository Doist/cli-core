import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { getConfigPath, readConfig, readConfigStrict, updateConfig, writeConfig } from './config.js'

interface TestConfig {
    token?: string
    workspace?: number
    nested?: { x?: number; y?: number }
}

let dir: string
let path: string

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cli-core-config-'))
    path = join(dir, 'nested', 'config.json')
})

afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
})

describe('getConfigPath', () => {
    it('joins under ~/.config/<appName>/config.json by default', () => {
        const previous = process.env.XDG_CONFIG_HOME
        delete process.env.XDG_CONFIG_HOME
        try {
            const result = getConfigPath('my-cli')
            expect(result.endsWith('/.config/my-cli/config.json')).toBe(true)
        } finally {
            if (previous !== undefined) process.env.XDG_CONFIG_HOME = previous
        }
    })

    it('honours XDG_CONFIG_HOME when set', () => {
        const previous = process.env.XDG_CONFIG_HOME
        process.env.XDG_CONFIG_HOME = '/tmp/xdg'
        try {
            expect(getConfigPath('my-cli')).toBe('/tmp/xdg/my-cli/config.json')
        } finally {
            if (previous === undefined) delete process.env.XDG_CONFIG_HOME
            else process.env.XDG_CONFIG_HOME = previous
        }
    })
})

describe('readConfig', () => {
    it('returns {} when the file is missing', async () => {
        const result = await readConfig<TestConfig>(path)
        expect(result).toEqual({})
    })

    it('returns {} when the file is invalid JSON', async () => {
        await mkdir(dirname(path), { recursive: true })
        await writeFile(path, 'not json', 'utf-8')
        const result = await readConfig<TestConfig>(path)
        expect(result).toEqual({})
    })

    it('returns {} when the JSON is not an object', async () => {
        await mkdir(dirname(path), { recursive: true })
        await writeFile(path, '[1, 2]', 'utf-8')
        const result = await readConfig<TestConfig>(path)
        expect(result).toEqual({})
    })

    it('round-trips a written config', async () => {
        await writeConfig<TestConfig>(path, { token: 'abc', workspace: 7 })
        const result = await readConfig<TestConfig>(path)
        expect(result).toEqual({ token: 'abc', workspace: 7 })
    })
})

describe('readConfigStrict', () => {
    it('reports missing files', async () => {
        const result = await readConfigStrict(path)
        expect(result).toEqual({ state: 'missing' })
    })

    it('reports read-failed for non-ENOENT errors', async () => {
        // Make the path itself a directory so readFile fails with EISDIR.
        await mkdir(path, { recursive: true })
        const result = await readConfigStrict(path)
        expect(result.state).toBe('read-failed')
        if (result.state === 'read-failed') expect(result.error).toBeInstanceOf(Error)
    })

    it('reports invalid JSON', async () => {
        await mkdir(dirname(path), { recursive: true })
        await writeFile(path, '{', 'utf-8')
        const result = await readConfigStrict(path)
        expect(result.state).toBe('invalid-json')
        if (result.state === 'invalid-json') expect(result.error).toBeInstanceOf(Error)
    })

    it('reports invalid shape (array)', async () => {
        await mkdir(dirname(path), { recursive: true })
        await writeFile(path, '[1, 2]', 'utf-8')
        const result = await readConfigStrict(path)
        expect(result).toEqual({ state: 'invalid-shape', actual: 'array' })
    })

    it('reports invalid shape (string)', async () => {
        await mkdir(dirname(path), { recursive: true })
        await writeFile(path, '"hello"', 'utf-8')
        const result = await readConfigStrict(path)
        expect(result).toEqual({ state: 'invalid-shape', actual: 'string' })
    })

    it('returns the parsed config when present', async () => {
        await writeConfig<TestConfig>(path, { token: 'abc' })
        const result = await readConfigStrict(path)
        expect(result).toEqual({ state: 'present', config: { token: 'abc' } })
    })
})

describe('writeConfig', () => {
    it('creates the parent directory with 0o700 and the file with 0o600', async () => {
        await writeConfig<TestConfig>(path, { token: 'abc' })
        const fileStat = await stat(path)
        const dirStat = await stat(dirname(path))
        expect(fileStat.mode & 0o777).toBe(0o600)
        expect(dirStat.mode & 0o777).toBe(0o700)
    })

    it('tightens an existing parent directory to 0o700', async () => {
        await mkdir(dirname(path), { recursive: true, mode: 0o755 })
        await writeConfig<TestConfig>(path, { token: 'abc' })
        const dirStat = await stat(dirname(path))
        expect(dirStat.mode & 0o777).toBe(0o700)
    })

    it('writes valid JSON with a trailing newline', async () => {
        await writeConfig<TestConfig>(path, { token: 'abc' })
        const raw = await readFile(path, 'utf-8')
        expect(raw.endsWith('\n')).toBe(true)
        expect(JSON.parse(raw)).toEqual({ token: 'abc' })
    })

    it('deletes the file when deleteWhenEmpty is set and config is empty', async () => {
        await writeConfig<TestConfig>(path, { token: 'abc' })
        await writeConfig<TestConfig>(path, {}, { deleteWhenEmpty: true })
        const result = await readConfigStrict(path)
        expect(result).toEqual({ state: 'missing' })
    })

    it('writes an empty object by default when config is empty', async () => {
        await writeConfig<TestConfig>(path, {})
        const raw = await readFile(path, 'utf-8')
        expect(JSON.parse(raw)).toEqual({})
    })
})

describe('updateConfig', () => {
    it('shallow-merges updates and replaces nested objects wholesale', async () => {
        await writeConfig<TestConfig>(path, {
            token: 'old',
            workspace: 1,
            nested: { x: 1, y: 2 },
        })
        await updateConfig<TestConfig>(path, { token: 'new', nested: { x: 10 } })
        const result = await readConfig<TestConfig>(path)
        // Top-level `workspace` survives; nested `y` is gone — proving shallow.
        expect(result).toEqual({ token: 'new', workspace: 1, nested: { x: 10 } })
    })

    it('creates the file when none exists', async () => {
        await updateConfig<TestConfig>(path, { workspace: 42 })
        const result = await readConfig<TestConfig>(path)
        expect(result).toEqual({ workspace: 42 })
    })

    it('throws when the existing file is invalid JSON instead of overwriting it', async () => {
        await mkdir(dirname(path), { recursive: true })
        await writeFile(path, '{ not json', 'utf-8')
        await expect(updateConfig<TestConfig>(path, { token: 'new' })).rejects.toThrow(
            /not valid JSON/,
        )
        // Original (broken) contents should be preserved on disk.
        expect(await readFile(path, 'utf-8')).toBe('{ not json')
    })

    it('throws when the existing file is the wrong shape', async () => {
        await mkdir(dirname(path), { recursive: true })
        await writeFile(path, '[1,2,3]', 'utf-8')
        await expect(updateConfig<TestConfig>(path, { token: 'new' })).rejects.toThrow(
            /not a JSON object/,
        )
    })
})
