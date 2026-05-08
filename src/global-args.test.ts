import { afterEach, describe, expect, it, vi } from 'vitest'

import {
    createAccessibleGate,
    createGlobalArgsStore,
    createSpinnerGate,
    getProgressJsonlPath,
    isProgressJsonlEnabled,
    parseGlobalArgs,
} from './global-args.js'

describe('parseGlobalArgs', () => {
    describe('long flags', () => {
        it('parses --json', () => {
            expect(parseGlobalArgs(['--json']).json).toBe(true)
        })
        it('parses --ndjson', () => {
            expect(parseGlobalArgs(['--ndjson']).ndjson).toBe(true)
        })
        it('parses --quiet', () => {
            expect(parseGlobalArgs(['--quiet']).quiet).toBe(true)
        })
        it('parses --verbose as 1', () => {
            expect(parseGlobalArgs(['--verbose']).verbose).toBe(1)
        })
        it('parses --accessible', () => {
            expect(parseGlobalArgs(['--accessible']).accessible).toBe(true)
        })
        it('parses --no-spinner', () => {
            expect(parseGlobalArgs(['--no-spinner']).noSpinner).toBe(true)
        })
        it('defaults all flags to false/0', () => {
            expect(parseGlobalArgs([])).toEqual({
                json: false,
                ndjson: false,
                quiet: false,
                verbose: 0,
                accessible: false,
                noSpinner: false,
                progressJsonl: false,
            })
        })
    })

    describe('short flags', () => {
        it('parses -q as quiet', () => {
            expect(parseGlobalArgs(['-q']).quiet).toBe(true)
        })
        it('parses -v as verbose level 1', () => {
            expect(parseGlobalArgs(['-v']).verbose).toBe(1)
        })
    })

    describe('grouped short flags', () => {
        it('parses -vq as verbose + quiet', () => {
            const r = parseGlobalArgs(['-vq'])
            expect(r.verbose).toBe(1)
            expect(r.quiet).toBe(true)
        })
        it('parses -qv as quiet + verbose', () => {
            const r = parseGlobalArgs(['-qv'])
            expect(r.verbose).toBe(1)
            expect(r.quiet).toBe(true)
        })
        it('parses -vvv as verbose level 3', () => {
            expect(parseGlobalArgs(['-vvv']).verbose).toBe(3)
        })
        it('parses -vvq as verbose level 2 + quiet', () => {
            const r = parseGlobalArgs(['-vvq'])
            expect(r.verbose).toBe(2)
            expect(r.quiet).toBe(true)
        })
        it('ignores unknown short flags', () => {
            const r = parseGlobalArgs(['-xvq'])
            expect(r.verbose).toBe(1)
            expect(r.quiet).toBe(true)
        })
    })

    describe('verbose counting', () => {
        it('stacks --verbose flags', () => {
            expect(parseGlobalArgs(['--verbose', '--verbose', '--verbose']).verbose).toBe(3)
        })
        it('stacks mixed -v and --verbose', () => {
            expect(parseGlobalArgs(['-vv', '--verbose']).verbose).toBe(3)
        })
        it('caps verbose at 4', () => {
            expect(parseGlobalArgs(['-vvvvvv']).verbose).toBe(4)
        })
        it('caps verbose at 4 with mixed flags', () => {
            expect(parseGlobalArgs(['-vvv', '--verbose', '--verbose']).verbose).toBe(4)
        })
    })

    describe('--progress-jsonl', () => {
        it('sets true when present without value', () => {
            expect(parseGlobalArgs(['--progress-jsonl']).progressJsonl).toBe(true)
        })
        it('extracts value from = format', () => {
            expect(parseGlobalArgs(['--progress-jsonl=/tmp/out']).progressJsonl).toBe('/tmp/out')
        })
        it('does not consume the next arg as a path (space-separated form unsupported)', () => {
            // Regression guard: the space form would silently swallow a
            // positional like `td task add --progress-jsonl "Buy milk"`.
            const r = parseGlobalArgs(['task', 'add', '--progress-jsonl', 'Buy milk'])
            expect(r.progressJsonl).toBe(true)
        })
        it('does not consume the next arg even when it starts with -', () => {
            const r = parseGlobalArgs(['--progress-jsonl', '--json'])
            expect(r.progressJsonl).toBe(true)
            expect(r.json).toBe(true)
        })
        it('preserves = characters in path value', () => {
            expect(parseGlobalArgs(['--progress-jsonl=/tmp/a=b=c']).progressJsonl).toBe(
                '/tmp/a=b=c',
            )
        })
    })

    describe('-- terminator', () => {
        it('stops parsing flags after --', () => {
            const r = parseGlobalArgs(['--json', '--', '-vq', '--quiet'])
            expect(r.json).toBe(true)
            expect(r.verbose).toBe(0)
            expect(r.quiet).toBe(false)
        })
    })

    describe('positional arguments', () => {
        it('does not treat positional args as flags', () => {
            expect(parseGlobalArgs(['today', '--json']).json).toBe(true)
        })
        it('handles mixed positional and flag args', () => {
            expect(parseGlobalArgs(['task', 'add', '--quiet', 'Buy milk']).quiet).toBe(true)
        })
    })
})

describe('isProgressJsonlEnabled / getProgressJsonlPath', () => {
    it('reports disabled when absent', () => {
        const args = parseGlobalArgs([])
        expect(isProgressJsonlEnabled(args)).toBe(false)
        expect(getProgressJsonlPath(args)).toBeUndefined()
    })
    it('reports enabled with no path when bare', () => {
        const args = parseGlobalArgs(['--progress-jsonl'])
        expect(isProgressJsonlEnabled(args)).toBe(true)
        expect(getProgressJsonlPath(args)).toBeUndefined()
    })
    it('reports enabled with path when set', () => {
        const args = parseGlobalArgs(['--progress-jsonl=/tmp/out'])
        expect(isProgressJsonlEnabled(args)).toBe(true)
        expect(getProgressJsonlPath(args)).toBe('/tmp/out')
    })
})

describe('createGlobalArgsStore', () => {
    const originalArgv = process.argv
    afterEach(() => {
        process.argv = originalArgv
    })

    it('caches the parsed result across calls', () => {
        process.argv = ['node', 'cli', '--json']
        const store = createGlobalArgsStore()
        expect(store.get().json).toBe(true)
        process.argv = ['node', 'cli']
        expect(store.get().json).toBe(true)
    })

    it('reset() forces re-parse', () => {
        process.argv = ['node', 'cli', '--json']
        const store = createGlobalArgsStore()
        expect(store.get().json).toBe(true)
        process.argv = ['node', 'cli']
        store.reset()
        expect(store.get().json).toBe(false)
    })

    it('accepts a custom parser for CLI-extended types', () => {
        type Extended = ReturnType<typeof parseGlobalArgs> & { user: string | undefined }
        const store = createGlobalArgsStore<Extended>(() => ({
            ...parseGlobalArgs(['--json']),
            user: 'scott@doist.com',
        }))
        const args = store.get()
        expect(args.json).toBe(true)
        expect(args.user).toBe('scott@doist.com')
    })
})

describe('createAccessibleGate', () => {
    afterEach(() => {
        vi.unstubAllEnvs()
    })

    it('returns true when env var is "1"', () => {
        vi.stubEnv('CORE_TEST_ACCESSIBLE', '1')
        const gate = createAccessibleGate({
            envVar: 'CORE_TEST_ACCESSIBLE',
            getArgs: () => parseGlobalArgs([]),
        })
        expect(gate()).toBe(true)
    })

    it('returns true when --accessible is parsed', () => {
        const gate = createAccessibleGate({
            envVar: 'CORE_TEST_ACCESSIBLE',
            getArgs: () => parseGlobalArgs(['--accessible']),
        })
        expect(gate()).toBe(true)
    })

    it('returns false when env var is set but not "1"', () => {
        vi.stubEnv('CORE_TEST_ACCESSIBLE', 'true')
        const gate = createAccessibleGate({
            envVar: 'CORE_TEST_ACCESSIBLE',
            getArgs: () => parseGlobalArgs([]),
        })
        expect(gate()).toBe(false)
    })

    it('returns false by default', () => {
        const gate = createAccessibleGate({
            envVar: 'CORE_TEST_ACCESSIBLE',
            getArgs: () => parseGlobalArgs([]),
        })
        expect(gate()).toBe(false)
    })
})

describe('createSpinnerGate', () => {
    afterEach(() => {
        vi.unstubAllEnvs()
    })

    it('returns false by default', () => {
        vi.stubEnv('CI', undefined)
        const gate = createSpinnerGate({
            envVar: 'CORE_TEST_SPINNER',
            getArgs: () => parseGlobalArgs([]),
        })
        expect(gate()).toBe(false)
    })

    it('returns true when env var equals "false"', () => {
        vi.stubEnv('CORE_TEST_SPINNER', 'false')
        const gate = createSpinnerGate({
            envVar: 'CORE_TEST_SPINNER',
            getArgs: () => parseGlobalArgs([]),
        })
        expect(gate()).toBe(true)
    })

    it('returns true under CI', () => {
        vi.stubEnv('CI', 'true')
        const gate = createSpinnerGate({
            envVar: 'CORE_TEST_SPINNER',
            getArgs: () => parseGlobalArgs([]),
        })
        expect(gate()).toBe(true)
    })

    it.each([
        ['--json', ['--json']],
        ['--ndjson', ['--ndjson']],
        ['--no-spinner', ['--no-spinner']],
        ['--progress-jsonl', ['--progress-jsonl']],
        ['--verbose', ['--verbose']],
        ['-v', ['-v']],
        ['-vq grouped', ['-vq']],
    ])('returns true with %s', (_label, argv) => {
        vi.stubEnv('CI', undefined)
        const gate = createSpinnerGate({
            envVar: 'CORE_TEST_SPINNER',
            getArgs: () => parseGlobalArgs(argv),
        })
        expect(gate()).toBe(true)
    })

    it.each([
        ['--quiet', ['--quiet']],
        ['-q', ['-q']],
        ['--accessible', ['--accessible']],
    ])('does not disable for %s (not a spinner trigger)', (_label, argv) => {
        vi.stubEnv('CI', undefined)
        const gate = createSpinnerGate({
            envVar: 'CORE_TEST_SPINNER',
            getArgs: () => parseGlobalArgs(argv),
        })
        expect(gate()).toBe(false)
    })

    it('returns true when extraTriggers returns true', () => {
        vi.stubEnv('CI', undefined)
        const gate = createSpinnerGate({
            envVar: 'CORE_TEST_SPINNER',
            getArgs: () => parseGlobalArgs([]),
            extraTriggers: () => true,
        })
        expect(gate()).toBe(true)
    })

    it('returns false when extraTriggers returns false and no other trigger', () => {
        vi.stubEnv('CI', undefined)
        const gate = createSpinnerGate({
            envVar: 'CORE_TEST_SPINNER',
            getArgs: () => parseGlobalArgs([]),
            extraTriggers: () => false,
        })
        expect(gate()).toBe(false)
    })

    it('does not call extraTriggers when env var already disables', () => {
        vi.stubEnv('CORE_TEST_SPINNER', 'false')
        const extra = vi.fn(() => false)
        const gate = createSpinnerGate({
            envVar: 'CORE_TEST_SPINNER',
            getArgs: () => parseGlobalArgs([]),
            extraTriggers: extra,
        })
        expect(gate()).toBe(true)
        expect(extra).not.toHaveBeenCalled()
    })

    it('does not call extraTriggers when CI already disables', () => {
        vi.stubEnv('CI', 'true')
        const extra = vi.fn(() => false)
        const gate = createSpinnerGate({
            envVar: 'CORE_TEST_SPINNER',
            getArgs: () => parseGlobalArgs([]),
            extraTriggers: extra,
        })
        expect(gate()).toBe(true)
        expect(extra).not.toHaveBeenCalled()
    })

    it('does not call extraTriggers when a canonical flag already disables', () => {
        vi.stubEnv('CI', undefined)
        const extra = vi.fn(() => false)
        const gate = createSpinnerGate({
            envVar: 'CORE_TEST_SPINNER',
            getArgs: () => parseGlobalArgs(['--json']),
            extraTriggers: extra,
        })
        expect(gate()).toBe(true)
        expect(extra).not.toHaveBeenCalled()
    })
})
