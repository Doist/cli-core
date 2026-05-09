import { readFile } from 'node:fs/promises'
import chalk from 'chalk'
import type { Command } from 'commander'
import { CliError } from '../errors.js'

export type ChangelogHeadingLevel = 1 | 2 | 'flexible'
export type ChangelogBulletMarker = '*' | '-'

export type ChangelogCommandOptions = {
    /**
     * Absolute path to the consuming CLI's `CHANGELOG.md`. Resolve from the
     * caller's `import.meta.url` so it works in both `src/` and built `dist/`.
     */
    path: string
    /** Repo URL with no trailing slash; the `/blob/v<version>/CHANGELOG.md` suffix is appended. */
    repoUrl: string
    /** Package version embedded in the "View full changelog" link. */
    version: string
    /** Default value for the `-n/--count` flag. Default: `5`. */
    defaultCount?: number
    /** Heading level used for version rows. Default: `2` (i.e. `## 1.2.3`). */
    headingLevel?: ChangelogHeadingLevel
    /** Bullet markers parsed and rendered. Default: `['*']`. */
    bulletMarkers?: ReadonlyArray<ChangelogBulletMarker>
    /** Indent continuation lines after a bullet (twist-style wrapped bullets). Default: `false`. */
    continuationIndent?: boolean
    /** Drop versions empty after cleaning (e.g. deps-only releases). Default: `false`. */
    filterEmptyVersions?: boolean
}

type ResolvedOptions = Required<Omit<ChangelogCommandOptions, 'path' | 'repoUrl' | 'version'>> &
    Pick<ChangelogCommandOptions, 'path' | 'repoUrl' | 'version'>

function resolve(options: ChangelogCommandOptions): ResolvedOptions {
    return {
        path: options.path,
        repoUrl: options.repoUrl,
        version: options.version,
        defaultCount: options.defaultCount ?? 5,
        headingLevel: options.headingLevel ?? 2,
        bulletMarkers: options.bulletMarkers ?? ['*'],
        continuationIndent: options.continuationIndent ?? false,
        filterEmptyVersions: options.filterEmptyVersions ?? false,
    }
}

function headingPrefixSrc(level: ChangelogHeadingLevel): string {
    if (level === 1) return '#'
    if (level === 2) return '##'
    return '#{1,2}'
}

function bulletCharClass(markers: ReadonlyArray<ChangelogBulletMarker>): string {
    if (markers.length === 1) return markers[0] === '*' ? '\\*' : '-'
    return '[*-]'
}

export function formatInline(text: string): string {
    return text
        .replace(/\*\*([^*]+)\*\*/g, (_, content) => chalk.bold(content))
        .replace(/`([^`]+)`/g, (_, code) => chalk.cyan(code))
}

export function formatForTerminal(text: string, options: ChangelogCommandOptions): string {
    const { headingLevel, bulletMarkers, continuationIndent } = resolve(options)
    const headerRe = new RegExp(`^${headingPrefixSrc(headingLevel)} `)
    const isBulletLine = (line: string) => bulletMarkers.some((m) => line.startsWith(`${m} `))

    let inBullet = false
    return text
        .split('\n')
        .map((line) => {
            if (headerRe.test(line)) {
                inBullet = false
                return chalk.green.bold(line.replace(headerRe, ''))
            }
            if (line.startsWith('### ')) {
                inBullet = false
                return chalk.bold(line.slice(4))
            }
            if (isBulletLine(line)) {
                inBullet = true
                return `  ${chalk.dim('•')} ${formatInline(line.slice(2))}`
            }
            if (continuationIndent && inBullet && line.length > 0) {
                return `    ${formatInline(line)}`
            }
            if (line.length === 0) {
                inBullet = false
            }
            return formatInline(line)
        })
        .join('\n')
}

export function cleanChangelog(text: string, options: ChangelogCommandOptions): string {
    const { headingLevel, bulletMarkers } = resolve(options)
    const bullets = bulletCharClass(bulletMarkers)
    const headerSrc = headingPrefixSrc(headingLevel)
    return (
        text
            // Version headers: `## [1.2.3](url)` → `## 1.2.3` (any heading level).
            .replace(/(#{1,2}) \[([^\]]+)\]\([^)]*\)/g, '$1 $2')
            // Plain commit-hash parens: ` (abc1234)` and ` ([abc1234](url))`.
            .replace(/ \([a-f0-9]{7}\)/g, '')
            .replace(/ \(\[[a-f0-9]{7}\]\([^)]*\)\)/g, '')
            // Issue / PR links: `[#nnn](url)` → `#nnn`.
            .replace(/\[#(\d+)\]\([^)]*\)/g, '#$1')
            // Drop `**deps:**` lines wholesale; not useful to end users.
            .replace(new RegExp(`^${bullets} \\*\\*deps:\\*\\*.*$`, 'gm'), '')
            // Drop `**scope:**` prefixes, keep the content: `**task:** foo` → `foo`.
            .replace(/\*\*[\w-]+:\*\* /g, '')
            // Collapse blank-line runs left by removed deps lines.
            .replace(/\n{3,}/g, '\n\n')
            // Drop now-empty section headers (e.g. `### Bug Fixes` with no items).
            .replace(new RegExp(`### [\\w ]+\\n\\n(?=${headerSrc} |$)`, 'gm'), '')
    )
}

function isEmptyAfterClean(section: string, options: ChangelogCommandOptions): boolean {
    const { headingLevel } = resolve(options)
    const cleaned = cleanChangelog(section, options)
    const headerRe = new RegExp(`^${headingPrefixSrc(headingLevel)} .+$`, 'm')
    return cleaned.replace(headerRe, '').trim().length === 0
}

export function parseChangelog(
    content: string,
    count: number,
    options: ChangelogCommandOptions,
): { text: string; hasMore: boolean } {
    const { headingLevel, filterEmptyVersions } = resolve(options)
    const headerSrc = headingPrefixSrc(headingLevel)
    const splitRe = new RegExp(`\\n(?=${headerSrc} (?:\\d|\\[))`)
    const matchRe = new RegExp(`^${headerSrc} (?:\\d|\\[)`)

    const allVersions = content.split(splitRe).filter((s) => matchRe.test(s))
    const versionSections = filterEmptyVersions
        ? allVersions.filter((s) => !isEmptyAfterClean(s, options))
        : allVersions
    const selected = versionSections.slice(0, count)

    if (selected.length === 0) {
        return { text: 'No changelog entries found.', hasMore: false }
    }

    return {
        text: cleanChangelog(selected.join('\n').trimEnd(), options),
        hasMore: versionSections.length > count,
    }
}

/**
 * Register the standard `<cli> changelog` command on a Commander program. The
 * command reads `options.path`, prints the latest `--count` versions with
 * conventional-commit boilerplate stripped, and appends a "View full
 * changelog" link to the matching tag on GitHub.
 *
 * Errors as `CliError`: `INVALID_TYPE` for a non-positive `--count`,
 * `FILE_READ_ERROR` if the file cannot be read. The consumer's top-level
 * error handler is expected to format and exit.
 *
 * ```ts
 * import { dirname, join } from 'node:path'
 * import { fileURLToPath } from 'node:url'
 * import { registerChangelogCommand } from '@doist/cli-core/commands'
 * import packageJson from '../package.json' with { type: 'json' }
 *
 * registerChangelogCommand(program, {
 *     path: join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'CHANGELOG.md'),
 *     repoUrl: 'https://github.com/Doist/todoist-cli',
 *     version: packageJson.version,
 * })
 * ```
 */
export function registerChangelogCommand(program: Command, options: ChangelogCommandOptions): void {
    const resolved = resolve(options)
    program
        .command('changelog')
        .description('Show recent changelog entries')
        .option('-n, --count <number>', 'Number of versions to show', String(resolved.defaultCount))
        .action(async (commandOptions: { count: string }) => {
            const count = Number.parseInt(commandOptions.count, 10)
            if (Number.isNaN(count) || count < 1) {
                throw new CliError('INVALID_TYPE', 'Count must be a positive number')
            }

            let content: string
            try {
                content = await readFile(options.path, 'utf-8')
            } catch {
                throw new CliError('FILE_READ_ERROR', 'Could not read changelog file')
            }

            const { text, hasMore } = parseChangelog(content, count, options)
            console.log(formatForTerminal(text, options))

            if (hasMore) {
                const url = `${options.repoUrl}/blob/v${options.version}/CHANGELOG.md`
                console.log(chalk.dim(`\nView full changelog: ${url}`))
            }
        })
}
