import chalk from 'chalk'
import { Command } from 'commander'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CliError } from '../errors.js'
import {
    cleanChangelog,
    formatForTerminal,
    formatInline,
    parseChangelog,
    registerChangelogCommand,
} from './changelog.js'

vi.mock('node:fs/promises', () => ({
    readFile: vi.fn(),
}))

const { readFile } = await import('node:fs/promises')

const FIXTURE = `# Changelog

All notable changes to this project will be documented in this file.

## [1.2.0](https://github.com/Doist/x/compare/v1.1.0...v1.2.0) (2025-01-02)

### Features

* add cool feature ([abc1234](https://github.com/Doist/x/commit/abc1234))
* **task:** another thing

### Bug Fixes

* fix wobble [#42](https://github.com/Doist/x/issues/42)

## [1.1.0](https://github.com/Doist/x/compare/v1.0.0...v1.1.0) (2025-01-01)

### Features

* **deps:** bump foo from 1 to 2

## [1.0.0](https://github.com/Doist/x/releases/tag/v1.0.0) (2024-12-31)

### Features

* initial release
`

const FIXTURE_FLEX = `# [2.0.0](https://github.com/Doist/x/compare/v1.0.0...v2.0.0) (2025-02-01)

### Features

* breaking change

## [1.0.0](https://github.com/Doist/x/releases/tag/v1.0.0) (2024-12-31)

### Features

* initial
`

const REQUIRED = {
    path: '/fake/CHANGELOG.md',
    repoUrl: 'https://github.com/Doist/x',
    version: '1.2.0',
}

beforeEach(() => {
    chalk.level = 0
})

afterEach(() => {
    vi.mocked(readFile).mockReset()
})

describe('formatInline', () => {
    it('renders bold and code spans', () => {
        const out = formatInline('hello **world** and `code`')
        expect(out).toBe('hello world and code')
    })
})

describe('cleanChangelog', () => {
    it('strips linked version headers, commit hashes, issue links, deps lines, scope prefixes', () => {
        const out = cleanChangelog(FIXTURE, REQUIRED)
        expect(out).toContain('## 1.2.0')
        expect(out).not.toContain('](https://')
        expect(out).not.toMatch(/\([a-f0-9]{7}\)/)
        expect(out).not.toContain('**deps:**')
        expect(out).not.toContain('**task:**')
        expect(out).toContain('#42')
    })

    it('handles flexible heading level rewrites', () => {
        const out = cleanChangelog(FIXTURE_FLEX, { ...REQUIRED, headingLevel: 'flexible' })
        expect(out).toMatch(/^# 2\.0\.0/m)
        expect(out).toMatch(/^## 1\.0\.0/m)
    })
})

describe('parseChangelog', () => {
    it('returns the latest N versions and hasMore', () => {
        const { text, hasMore } = parseChangelog(FIXTURE, 1, REQUIRED)
        expect(text).toContain('## 1.2.0')
        expect(text).not.toContain('## 1.1.0')
        expect(hasMore).toBe(true)
    })

    it('returns hasMore=false when count meets total', () => {
        const { hasMore } = parseChangelog(FIXTURE, 3, REQUIRED)
        expect(hasMore).toBe(false)
    })

    it('returns the empty-state message when nothing matches', () => {
        const { text, hasMore } = parseChangelog('# Just a preamble\n\nNothing here.', 5, REQUIRED)
        expect(text).toBe('No changelog entries found.')
        expect(hasMore).toBe(false)
    })

    it('filterEmptyVersions drops deps-only releases', () => {
        const { text, hasMore } = parseChangelog(FIXTURE, 5, {
            ...REQUIRED,
            filterEmptyVersions: true,
        })
        expect(text).toContain('## 1.2.0')
        expect(text).toContain('## 1.0.0')
        expect(text).not.toContain('## 1.1.0')
        expect(hasMore).toBe(false)
    })
})

describe('formatForTerminal', () => {
    it('renders version row, section header, and bullet', () => {
        const cleaned = cleanChangelog(FIXTURE, REQUIRED)
        const out = formatForTerminal(cleaned, REQUIRED)
        expect(out).toContain('1.2.0')
        expect(out).toContain('Features')
        expect(out).toMatch(/^ {2}• add cool feature/m)
    })

    it('treats `-` as a bullet when configured', () => {
        const out = formatForTerminal('- alpha\n- beta', { ...REQUIRED, bulletMarkers: ['*', '-'] })
        expect(out).toMatch(/^ {2}• alpha/m)
        expect(out).toMatch(/^ {2}• beta/m)
    })

    it('indents continuation lines under continuationIndent', () => {
        const out = formatForTerminal('* first\nwrapped continuation', {
            ...REQUIRED,
            continuationIndent: true,
        })
        expect(out).toMatch(/^ {2}• first/m)
        expect(out).toMatch(/^ {4}wrapped continuation/m)
    })

    it('renders flexible heading rows of either level', () => {
        const cleaned = cleanChangelog(FIXTURE_FLEX, { ...REQUIRED, headingLevel: 'flexible' })
        const out = formatForTerminal(cleaned, { ...REQUIRED, headingLevel: 'flexible' })
        expect(out).toContain('2.0.0')
        expect(out).toContain('1.0.0')
        expect(out).not.toMatch(/^#/m)
    })
})

describe('registerChangelogCommand', () => {
    function makeProgram(): Command {
        const program = new Command()
        program.exitOverride()
        return program
    }

    it('prints formatted output and footer link when more versions exist', async () => {
        vi.mocked(readFile).mockResolvedValueOnce(FIXTURE)
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
        const program = makeProgram()
        registerChangelogCommand(program, REQUIRED)
        await program.parseAsync(['node', 'cli', 'changelog', '-n', '1'])

        const all = logSpy.mock.calls.map((c) => c[0]).join('\n')
        expect(all).toContain('1.2.0')
        expect(all).toContain('Features')
        expect(all).toContain(
            'View full changelog: https://github.com/Doist/x/blob/v1.2.0/CHANGELOG.md',
        )
        logSpy.mockRestore()
    })

    it('omits the footer when no more versions remain', async () => {
        vi.mocked(readFile).mockResolvedValueOnce(FIXTURE)
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
        const program = makeProgram()
        registerChangelogCommand(program, REQUIRED)
        await program.parseAsync(['node', 'cli', 'changelog', '-n', '10'])

        const all = logSpy.mock.calls.map((c) => c[0]).join('\n')
        expect(all).not.toContain('View full changelog')
        logSpy.mockRestore()
    })

    it('throws CliError(INVALID_TYPE) for non-positive count', async () => {
        const program = makeProgram()
        registerChangelogCommand(program, REQUIRED)
        await expect(
            program.parseAsync(['node', 'cli', 'changelog', '-n', '0']),
        ).rejects.toMatchObject({
            name: 'CliError',
            code: 'INVALID_TYPE',
        })
    })

    it('throws CliError(INVALID_TYPE) for non-numeric count', async () => {
        const program = makeProgram()
        registerChangelogCommand(program, REQUIRED)
        await expect(
            program.parseAsync(['node', 'cli', 'changelog', '-n', 'abc']),
        ).rejects.toBeInstanceOf(CliError)
    })

    it('throws CliError(FILE_READ_ERROR) when the file is unreadable', async () => {
        vi.mocked(readFile).mockRejectedValueOnce(new Error('ENOENT'))
        const program = makeProgram()
        registerChangelogCommand(program, REQUIRED)
        await expect(program.parseAsync(['node', 'cli', 'changelog'])).rejects.toMatchObject({
            name: 'CliError',
            code: 'FILE_READ_ERROR',
        })
    })

    it('honours defaultCount in the option default', async () => {
        vi.mocked(readFile).mockResolvedValueOnce(FIXTURE)
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
        const program = makeProgram()
        registerChangelogCommand(program, { ...REQUIRED, defaultCount: 1 })
        await program.parseAsync(['node', 'cli', 'changelog'])

        const all = logSpy.mock.calls.map((c) => c[0]).join('\n')
        expect(all).toContain('1.2.0')
        expect(all).not.toContain('1.1.0')
        expect(all).toContain('View full changelog')
        logSpy.mockRestore()
    })
})
