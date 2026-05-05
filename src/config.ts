import { chmod, mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/**
 * Resolve the canonical config path for a CLI: `~/.config/<appName>/config.json`.
 */
export function getConfigPath(appName: string): string {
    return join(homedir(), '.config', appName, 'config.json')
}

/**
 * Read and parse a JSON config file leniently. Returns `{}` cast to `T` when
 * the file is missing, unreadable, invalid JSON, or not a JSON object — the
 * shape runtime code paths expect ("no config" looks the same as "empty config").
 *
 * Use `readConfigStrict` instead when you need to distinguish those failure
 * modes (e.g. `doctor`-style inspection commands).
 */
export async function readConfig<T extends object>(path: string): Promise<T> {
    try {
        const content = await readFile(path, 'utf-8')
        const parsed = JSON.parse(content) as unknown
        return isPlainObject(parsed) ? (parsed as T) : ({} as T)
    } catch {
        return {} as T
    }
}

export type ReadConfigStrictResult<T extends object> =
    | { state: 'missing' }
    | { state: 'read-failed'; error: Error }
    | { state: 'invalid-json'; error: Error }
    | { state: 'invalid-shape'; actual: 'array' | 'null' | 'number' | 'string' | 'boolean' }
    | { state: 'present'; config: T }

/**
 * Read and parse a JSON config file strictly, distinguishing missing files
 * from broken ones. The library returns a discriminated result instead of
 * throwing so consumers can format errors with their own copy/codes.
 */
export async function readConfigStrict<T extends object>(
    path: string,
): Promise<ReadConfigStrictResult<T>> {
    let content: string
    try {
        content = await readFile(path, 'utf-8')
    } catch (error) {
        if (isMissingFileError(error)) return { state: 'missing' }
        return { state: 'read-failed', error: toError(error) }
    }

    let parsed: unknown
    try {
        parsed = JSON.parse(content)
    } catch (error) {
        return { state: 'invalid-json', error: toError(error) }
    }

    if (!isPlainObject(parsed)) {
        return { state: 'invalid-shape', actual: describeNonObject(parsed) }
    }

    return { state: 'present', config: parsed as T }
}

export interface WriteConfigOptions {
    /**
     * When true and the supplied config has no own enumerable keys, delete the
     * file instead of writing an empty `{}`. Default false.
     */
    deleteWhenEmpty?: boolean
}

/**
 * Write a config file with restrictive permissions (parent dir 0700, file 0600)
 * and a trailing newline. Creates parent directories as needed.
 */
export async function writeConfig<T extends object>(
    path: string,
    config: T,
    options: WriteConfigOptions = {},
): Promise<void> {
    if (options.deleteWhenEmpty && Object.keys(config).length === 0) {
        try {
            await unlink(path)
        } catch (error) {
            if (!isMissingFileError(error)) throw error
        }
        return
    }

    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, {
        encoding: 'utf-8',
        mode: 0o600,
    })
    await chmod(path, 0o600)
}

/**
 * Read the existing config (leniently), shallow-merge the supplied updates,
 * and write the result.
 */
export async function updateConfig<T extends object>(
    path: string,
    updates: Partial<T>,
    options: WriteConfigOptions = {},
): Promise<void> {
    const existing = await readConfig<T>(path)
    await writeConfig(path, { ...existing, ...updates }, options)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isMissingFileError(error: unknown): boolean {
    return (
        error instanceof Error && 'code' in error && (error as { code?: unknown }).code === 'ENOENT'
    )
}

function toError(value: unknown): Error {
    return value instanceof Error ? value : new Error(String(value))
}

function describeNonObject(value: unknown): 'array' | 'null' | 'number' | 'string' | 'boolean' {
    if (Array.isArray(value)) return 'array'
    if (value === null) return 'null'
    const t = typeof value
    if (t === 'number' || t === 'string' || t === 'boolean') return t
    return 'null'
}
