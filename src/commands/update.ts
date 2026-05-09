import { spawn } from 'node:child_process'
import chalk from 'chalk'
import type { Command } from 'commander'
import {
    BROKEN_CONFIG_STATE_TO_CODE,
    type CoreConfig,
    readConfig,
    readConfigStrict,
    type UpdateChannel,
    updateConfig,
} from '../config.js'
import { CliError } from '../errors.js'
import { formatJson, formatNdjson } from '../json.js'
import type { ViewOptions } from '../options.js'
import type { SpinnerOptions } from '../spinner.js'

const DEFAULT_REGISTRY_URL = 'https://registry.npmjs.org'

type WithSpinner = <T>(options: SpinnerOptions, op: () => Promise<T>) => Promise<T>

export type UpdateCommandOptions = {
    /** npm package name to query the registry for, e.g. `'@doist/todoist-cli'`. */
    packageName: string
    /** Caller's current version (read from their package.json at startup). */
    currentVersion: string
    /** Absolute path to the CLI's config file (use `getConfigPath(appName)`). */
    configPath: string
    /** Override the npm registry base URL. Default `'https://registry.npmjs.org'`. */
    registryUrl?: string
    /**
     * Hint shown after a successful stable-channel install, e.g. `'td changelog'`.
     * Omit to skip the post-update tip.
     */
    changelogCommandName?: string
    /**
     * Optional spinner runner — typically `withSpinner` from a `createSpinner()`
     * kit. When omitted, the operation runs without a spinner.
     */
    withSpinner?: WithSpinner
}

type ParsedVersion = {
    major: number
    minor: number
    patch: number
    prerelease: string | undefined
}

export function parseVersion(version: string): ParsedVersion {
    const [core, ...rest] = version.replace(/^v/, '').split('-')
    const [major, minor, patch] = core.split('.').map(Number)
    return { major, minor, patch, prerelease: rest.length > 0 ? rest.join('-') : undefined }
}

/** Numeric-aware semver compare. Returns -1, 0, or 1. Pre-releases sort below the same core. */
export function compareVersions(a: string, b: string): number {
    const left = parseVersion(a)
    const right = parseVersion(b)
    for (const key of ['major', 'minor', 'patch'] as const) {
        if (left[key] !== right[key]) return left[key] > right[key] ? 1 : -1
    }
    if (!left.prerelease && right.prerelease) return 1
    if (left.prerelease && !right.prerelease) return -1
    if (left.prerelease && right.prerelease) {
        return left.prerelease.localeCompare(right.prerelease, undefined, { numeric: true })
    }
    return 0
}

/** Returns true when `candidate` is strictly newer than `current` per semver. */
export function isNewer(current: string, candidate: string): boolean {
    return compareVersions(candidate, current) > 0
}

/** Map an `UpdateChannel` to its npm dist-tag. */
export function getInstallTag(channel: UpdateChannel): string {
    return channel === 'pre-release' ? 'next' : 'latest'
}

export async function fetchLatestVersion(args: {
    packageName: string
    channel: UpdateChannel
    registryUrl?: string
}): Promise<string> {
    const base = args.registryUrl ?? DEFAULT_REGISTRY_URL
    const url = `${base}/${args.packageName}/${getInstallTag(args.channel)}`
    const response = await fetch(url)
    if (!response.ok) {
        throw new Error(`Registry request failed (HTTP ${response.status})`)
    }
    const data = (await response.json()) as { version: string }
    return data.version
}

/** Read the persisted channel; missing or unreadable config falls back to `'stable'`. */
export async function getConfiguredUpdateChannel(configPath: string): Promise<UpdateChannel> {
    const config = await readConfig<CoreConfig>(configPath)
    return config.update_channel ?? 'stable'
}

function detectPackageManager(): string {
    const execPath = process.env.npm_execpath ?? ''
    return execPath.includes('pnpm') ? 'pnpm' : 'npm'
}

function runInstall(
    pm: string,
    packageName: string,
    tag: string,
): Promise<{ exitCode: number; stderr: string }> {
    const command = pm === 'pnpm' ? 'add' : 'install'
    return new Promise((resolve, reject) => {
        const child = spawn(pm, [command, '-g', `${packageName}@${tag}`], { stdio: 'pipe' })
        let stderr = ''
        child.stderr?.on('data', (data: Buffer) => {
            stderr += data.toString()
        })
        child.on('error', reject)
        child.on('close', (code) => resolve({ exitCode: code ?? 1, stderr }))
    })
}

function emit(
    view: ViewOptions,
    payload: Record<string, unknown>,
    humanLines: () => ReadonlyArray<string>,
): void {
    if (view.json) {
        console.log(formatJson(payload))
        return
    }
    if (view.ndjson) {
        console.log(formatNdjson([payload]))
        return
    }
    for (const line of humanLines()) console.log(line)
}

function channelLabel(channel: UpdateChannel): string {
    return channel === 'pre-release' ? ` ${chalk.magenta('(pre-release)')}` : ''
}

async function persistChannel(configPath: string, channel: UpdateChannel): Promise<void> {
    // Pre-check so a broken config surfaces as a typed CliError instead of the
    // raw Error that updateConfig throws.
    const result = await readConfigStrict(configPath)
    if (
        result.state === 'read-failed' ||
        result.state === 'invalid-json' ||
        result.state === 'invalid-shape'
    ) {
        const detail =
            result.state === 'invalid-shape'
                ? `contents are ${result.actual}, not a JSON object`
                : result.error.message
        throw new CliError(
            BROKEN_CONFIG_STATE_TO_CODE[result.state],
            `Cannot update config at ${configPath}: ${detail}`,
        )
    }
    await updateConfig<CoreConfig>(configPath, { update_channel: channel })
}

type UpdateCmdOptions = {
    check?: boolean
    channel?: boolean
    json?: boolean
    ndjson?: boolean
}

async function runUpdate(options: UpdateCommandOptions, cmd: UpdateCmdOptions): Promise<void> {
    if (cmd.check && cmd.channel) {
        throw new CliError('INVALID_FLAGS', 'Specify either --check or --channel, not both.')
    }

    const view: ViewOptions = { json: cmd.json, ndjson: cmd.ndjson }
    const channel = await getConfiguredUpdateChannel(options.configPath)

    if (cmd.channel) {
        emit(view, { channel }, () => [
            `Update channel: ${
                channel === 'pre-release' ? chalk.magenta('pre-release') : chalk.green('stable')
            }`,
        ])
        return
    }

    const tag = getInstallTag(channel)
    const label = channelLabel(channel)
    const fetchOp = () =>
        fetchLatestVersion({
            packageName: options.packageName,
            channel,
            registryUrl: options.registryUrl,
        })

    let latestVersion: string
    try {
        latestVersion = options.withSpinner
            ? await options.withSpinner(
                  { text: `Checking for updates${label}...`, color: 'blue' },
                  fetchOp,
              )
            : await fetchOp()
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        throw new CliError('UPDATE_CHECK_FAILED', `Failed to check for updates: ${message}`)
    }

    const { currentVersion } = options
    const updateAvailable = isNewer(currentVersion, latestVersion)

    if (cmd.check) {
        emit(view, { currentVersion, latestVersion, channel, updateAvailable }, () => {
            const channelLine =
                channel === 'pre-release'
                    ? `  Channel: ${chalk.magenta('pre-release')}`
                    : `  Channel: ${chalk.green('stable')}`
            const headline = updateAvailable
                ? `Update available: ${chalk.dim(`v${currentVersion}`)} → ${chalk.green(`v${latestVersion}`)}`
                : `${chalk.green('✓')} Already up to date (v${currentVersion})`
            return [headline, channelLine]
        })
        return
    }

    if (currentVersion === latestVersion) {
        emit(view, { currentVersion, latestVersion, channel, installed: false }, () => [
            `${chalk.green('✓')} Already up to date${label} (v${currentVersion})`,
        ])
        return
    }

    if (!view.json && !view.ndjson) {
        const headline = updateAvailable
            ? `Update available${label}: ${chalk.dim(`v${currentVersion}`)} → ${chalk.green(`v${latestVersion}`)}`
            : `Downgrade available${label}: ${chalk.dim(`v${currentVersion}`)} → ${chalk.yellow(`v${latestVersion}`)}`
        console.log(headline)
    }

    const pm = detectPackageManager()
    const installOp = () => runInstall(pm, options.packageName, tag)

    let result: { exitCode: number; stderr: string }
    try {
        result = options.withSpinner
            ? await options.withSpinner(
                  { text: `Updating to v${latestVersion}${label}...`, color: 'blue' },
                  installOp,
              )
            : await installOp()
    } catch (error) {
        if (
            error instanceof Error &&
            'code' in error &&
            (error as { code?: unknown }).code === 'EACCES'
        ) {
            throw new CliError('UPDATE_INSTALL_FAILED', 'Permission denied.', {
                hints: [
                    `Run with sudo: sudo ${pm} ${pm === 'pnpm' ? 'add' : 'install'} -g ${options.packageName}@${tag}`,
                ],
            })
        }
        const message = error instanceof Error ? error.message : String(error)
        throw new CliError('UPDATE_INSTALL_FAILED', `Install failed: ${message}`)
    }

    if (result.exitCode !== 0) {
        throw new CliError(
            'UPDATE_INSTALL_FAILED',
            `${pm} exited with code ${result.exitCode}`,
            result.stderr ? { hints: [result.stderr.trim()] } : {},
        )
    }

    emit(view, { currentVersion, latestVersion, channel, installed: true }, () => {
        const lines = [`${chalk.green('✓')} Updated to v${latestVersion}${label}`]
        if (channel === 'stable' && options.changelogCommandName) {
            lines.push(
                `${chalk.dim('  Run')} ${chalk.cyan(options.changelogCommandName)} ${chalk.dim('to see what changed')}`,
            )
        }
        return lines
    })
}

type SwitchCmdOptions = {
    stable?: boolean
    preRelease?: boolean
    json?: boolean
    ndjson?: boolean
}

async function runSwitch(
    options: UpdateCommandOptions,
    cmd: SwitchCmdOptions,
    program: Command,
): Promise<void> {
    if (cmd.stable && cmd.preRelease) {
        throw new CliError('INVALID_FLAGS', 'Specify either --stable or --pre-release, not both.')
    }
    if (!cmd.stable && !cmd.preRelease) {
        throw new CliError('INVALID_FLAGS', 'Specify --stable or --pre-release.')
    }

    const channel: UpdateChannel = cmd.preRelease ? 'pre-release' : 'stable'
    const view: ViewOptions = { json: cmd.json, ndjson: cmd.ndjson }

    await persistChannel(options.configPath, channel)

    emit(view, { channel }, () => {
        if (channel === 'pre-release') {
            const cliName = program.name()
            return [
                `${chalk.green('✓')} Update channel set to ${chalk.magenta('pre-release')}`,
                '',
                `${chalk.yellow('Note:')} Pre-release updates follow the ${chalk.cyan('next')} branch.`,
                'When pre-release changes are merged into a stable release, no further',
                'pre-release updates will be published until a new pre-release cycle begins.',
                'Remember to switch back to stable when done:',
                chalk.dim(`  ${cliName} update switch --stable`),
            ]
        }
        return [`${chalk.green('✓')} Update channel set to stable`]
    })
}

/**
 * Register the standard `<cli> update` and `<cli> update switch` commands on a
 * Commander program. The `update` action checks the npm registry for the
 * configured channel's dist-tag, compares against `currentVersion`, and shells
 * out to `npm i -g` (or `pnpm add -g` if `npm_execpath` indicates pnpm).
 * `update switch` flips the persisted `update_channel` field between `'stable'`
 * and `'pre-release'`.
 *
 * Errors as `CliError` (`INVALID_FLAGS`, `UPDATE_CHECK_FAILED`,
 * `UPDATE_INSTALL_FAILED`, or the canonical `CONFIG_*` codes when the config
 * file is broken). The consumer's top-level error handler is expected to format
 * and exit.
 *
 * Both subcommands accept `--json` / `--ndjson`; success branches emit a single
 * record (`{ currentVersion, latestVersion, channel, updateAvailable | installed }`
 * for `update`, `{ channel }` for `update switch`).
 *
 * ```ts
 * import { getConfigPath, createSpinner } from '@doist/cli-core'
 * import { registerUpdateCommand } from '@doist/cli-core/commands'
 * import packageJson from '../package.json' with { type: 'json' }
 *
 * const { withSpinner } = createSpinner()
 * registerUpdateCommand(program, {
 *     packageName: '@doist/todoist-cli',
 *     currentVersion: packageJson.version,
 *     configPath: getConfigPath('todoist-cli'),
 *     changelogCommandName: 'td changelog',
 *     withSpinner,
 * })
 * ```
 */
export function registerUpdateCommand(program: Command, options: UpdateCommandOptions): void {
    const update = program
        .command('update')
        .description('Update the CLI to the latest version for the configured channel')
        .option('--check', 'Check for updates without installing')
        .option('--channel', 'Show the current update channel')
        .option('--json', 'Emit machine-readable JSON output')
        .option('--ndjson', 'Emit machine-readable NDJSON output')
        .action(async (cmdOptions: UpdateCmdOptions) => {
            await runUpdate(options, cmdOptions)
        })

    update
        .command('switch')
        .description('Switch update channel between stable and pre-release')
        .option('--stable', 'Use the stable release channel')
        .option('--pre-release', 'Use the pre-release (next) channel')
        .option('--json', 'Emit machine-readable JSON output')
        .option('--ndjson', 'Emit machine-readable NDJSON output')
        .action(async function (this: Command) {
            // optsWithGlobals merges parent (`update`) options into the
            // subcommand's view; without this, `--json` / `--ndjson` would land
            // on the parent because they're declared on both.
            await runSwitch(options, this.optsWithGlobals() as SwitchCmdOptions, program)
        })
}
