import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { getConfigPath, readConfig, readConfigStrict, updateConfig, writeConfig } from './config.js'

interface TestConfig {
    token?: string
    workspace?: number
    nested?: { flag?: boolean }
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
    it('joins under ~/.config/<appName>/config.json', () => {
        const result = getConfigPath('my-cli')
        expect(result.endsWith('/.config/my-cli/config.json')).toBe(true)
    })
})

describe('readConfig', () => {
    it('returns {} when the file is missing', async () => {
        const result = await readConfig<TestConfig>(path)
        expect(result).toEqual({})
    })

    it('returns {} when the file is invalid JSON', async () => {
        await writeConfig(path, { token: 'a' })
        await writeFile(path, 'not json', 'utf-8')
        const result = await readConfig<TestConfig>(path)
        expect(result).toEqual({})
    })

    it('returns {} when the JSON is not an object', async () => {
        await writeConfig(path, { token: 'a' })
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
        const result = await readConfigStrict<TestConfig>(path)
        expect(result).toEqual({ state: 'missing' })
    })

    it('reports invalid JSON', async () => {
        await writeConfig(path, { token: 'a' })
        await writeFile(path, '{', 'utf-8')
        const result = await readConfigStrict<TestConfig>(path)
        expect(result.state).toBe('invalid-json')
        if (result.state === 'invalid-json') expect(result.error).toBeInstanceOf(Error)
    })

    it('reports invalid shape (array)', async () => {
        await writeConfig(path, { token: 'a' })
        await writeFile(path, '[1, 2]', 'utf-8')
        const result = await readConfigStrict<TestConfig>(path)
        expect(result).toEqual({ state: 'invalid-shape', actual: 'array' })
    })

    it('reports invalid shape (string)', async () => {
        await writeConfig(path, { token: 'a' })
        await writeFile(path, '"hello"', 'utf-8')
        const result = await readConfigStrict<TestConfig>(path)
        expect(result).toEqual({ state: 'invalid-shape', actual: 'string' })
    })

    it('returns the parsed config when present', async () => {
        await writeConfig<TestConfig>(path, { token: 'abc' })
        const result = await readConfigStrict<TestConfig>(path)
        expect(result).toEqual({ state: 'present', config: { token: 'abc' } })
    })
})

describe('writeConfig', () => {
    it('creates parent directories with restrictive permissions', async () => {
        await writeConfig<TestConfig>(path, { token: 'abc' })
        const fileStat = await stat(path)
        expect(fileStat.mode & 0o777).toBe(0o600)
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
        const result = await readConfigStrict<TestConfig>(path)
        expect(result).toEqual({ state: 'missing' })
    })

    it('writes an empty object by default when config is empty', async () => {
        await writeConfig<TestConfig>(path, {})
        const raw = await readFile(path, 'utf-8')
        expect(JSON.parse(raw)).toEqual({})
    })
})

describe('updateConfig', () => {
    it('shallow-merges updates into existing config', async () => {
        await writeConfig<TestConfig>(path, { token: 'old', workspace: 1 })
        await updateConfig<TestConfig>(path, { token: 'new' })
        const result = await readConfig<TestConfig>(path)
        expect(result).toEqual({ token: 'new', workspace: 1 })
    })

    it('creates the file when none exists', async () => {
        await updateConfig<TestConfig>(path, { workspace: 42 })
        const result = await readConfig<TestConfig>(path)
        expect(result).toEqual({ workspace: 42 })
    })
})
