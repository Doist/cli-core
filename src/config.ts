import { chmod, mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { formatJson } from './json.js'

/**
 * Resolve the canonical config path for a CLI, honouring `XDG_CONFIG_HOME`
 * when set: `${XDG_CONFIG_HOME ?? ~/.config}/<appName>/config.json`.
 */
export function getConfigPath(appName: string): string {
    const base = process.env.XDG_CONFIG_HOME || join(homedir(), '.config')
    return join(base, appName, 'config.json')
}

/**
 * Read and parse a JSON config file leniently. Returns `{}` when the file is
 * missing, unreadable, invalid JSON, or not a JSON object — the shape runtime
 * code paths expect ("no config" looks the same as "empty config").
 *
 * The return type is `Partial<T>` because at runtime any field may be absent;
 * the cast is the consumer's responsibility once they have validated.
 *
 * Use `readConfigStrict` instead when you need to distinguish failure modes
 * (e.g. `doctor`-style inspection commands).
 */
export async function readConfig<T extends object>(path: string): Promise<Partial<T>> {
    const result = await readConfigStrict(path)
    return result.state === 'present' ? (result.config as Partial<T>) : {}
}

export type ReadConfigStrictResult =
    | { state: 'missing' }
    | { state: 'read-failed'; error: Error }
    | { state: 'invalid-json'; error: Error }
    | { state: 'invalid-shape'; actual: 'array' | 'null' | 'number' | 'string' | 'boolean' }
    | { state: 'present'; config: Record<string, unknown> }

/**
 * Read and parse a JSON config file strictly, distinguishing missing files
 * from broken ones. The library returns a discriminated result instead of
 * throwing so consumers can format errors with their own copy/codes.
 *
 * `present.config` is typed as `Record<string, unknown>` because cli-core does
 * not validate shape — only that the file parsed to a plain object. Cast or
 * decode in the consumer.
 */
export async function readConfigStrict(path: string): Promise<ReadConfigStrictResult> {
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

    return { state: 'present', config: parsed }
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
 * and a trailing newline. Creates parent directories as needed and tightens
 * their permissions even if they already existed.
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

    const dir = dirname(path)
    await mkdir(dir, { recursive: true, mode: 0o700 })
    await chmod(dir, 0o700)
    await writeFile(path, `${formatJson(config)}\n`, {
        encoding: 'utf-8',
        mode: 0o600,
    })
    await chmod(path, 0o600)
}

/**
 * Read the existing config strictly, shallow-merge the supplied updates, and
 * write the result. Throws if the existing file is unreadable or unparseable
 * to avoid silently overwriting data that a user might still recover by
 * fixing their config file.
 */
export async function updateConfig<T extends object>(
    path: string,
    updates: Partial<T>,
    options: WriteConfigOptions = {},
): Promise<void> {
    const result = await readConfigStrict(path)
    switch (result.state) {
        case 'missing':
            await writeConfig(path, updates, options)
            return
        case 'present':
            await writeConfig(path, { ...result.config, ...updates }, options)
            return
        case 'read-failed':
            throw new Error(`Cannot update config at ${path}: ${result.error.message}`)
        case 'invalid-json':
            throw new Error(
                `Cannot update config at ${path}: file is not valid JSON (${result.error.message}). Fix or remove the file before retrying.`,
            )
        case 'invalid-shape':
            throw new Error(
                `Cannot update config at ${path}: file contents are ${result.actual}, not a JSON object. Fix or remove the file before retrying.`,
            )
    }
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
