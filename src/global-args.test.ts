import { afterEach, describe, expect, it, vi } from 'vitest'

import {
    type GlobalArgs,
    createAccessibleGate,
    createGlobalArgsStore,
    createSpinnerGate,
    getProgressJsonlPath,
    isProgressJsonlEnabled,
    parseGlobalArgs,
    stripUserFlag,
} from './global-args.js'

describe('parseGlobalArgs', () => {
    it('defaults every field to false/0', () => {
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

    it.each([
        ['--json', 'json', true],
        ['--ndjson', 'ndjson', true],
        ['--quiet', 'quiet', true],
        ['--verbose', 'verbose', 1],
        ['--accessible', 'accessible', true],
        ['--no-spinner', 'noSpinner', true],
    ] as const)('flips %s -> %s', (flag, field, expected) => {
        expect(parseGlobalArgs([flag])[field]).toBe(expected)
    })

    it.each([
        // Single short flag
        [['-q'], { quiet: true }],
        [['-v'], { verbose: 1 }],
        // Group order doesn't matter
        [['-vq'], { verbose: 1, quiet: true }],
        [['-qv'], { verbose: 1, quiet: true }],
        // Repeats stack within a group
        [['-vvv'], { verbose: 3 }],
        [['-vvq'], { verbose: 2, quiet: true }],
        // Unknown shorts are silently dropped
        [['-xvq'], { verbose: 1, quiet: true }],
    ])('parses short flags %j', (argv, expected) => {
        expect(parseGlobalArgs(argv)).toMatchObject(expected)
    })

    it('verbose stacks across mixed long + short forms', () => {
        expect(parseGlobalArgs(['-vv', '--verbose']).verbose).toBe(3)
    })

    it('caps verbose at 4', () => {
        expect(parseGlobalArgs(['-vvv', '--verbose', '--verbose']).verbose).toBe(4)
    })

    it.each([
        // bare -> stderr
        [['--progress-jsonl'], true],
        // = form -> path
        [['--progress-jsonl=/tmp/out'], '/tmp/out'],
        // Regression: space form is not supported. `td task add --progress-jsonl "Buy milk"`
        // must NOT consume "Buy milk" as a file path.
        [['task', 'add', '--progress-jsonl', 'Buy milk'], true],
    ] as const)('parses --progress-jsonl %j -> %j', (argv, expected) => {
        expect(parseGlobalArgs([...argv]).progressJsonl).toEqual(expected)
    })

    it('stops parsing flags after the -- terminator', () => {
        expect(parseGlobalArgs(['--json', '--', '-vq', '--quiet'])).toMatchObject({
            json: true,
            verbose: 0,
            quiet: false,
        })
    })

    it('reads global flags regardless of position relative to positionals', () => {
        expect(parseGlobalArgs(['task', 'add', '--quiet', 'Buy milk']).quiet).toBe(true)
    })
})

describe('parseGlobalArgs --user', () => {
    it.each([
        [['--user', 'alice'], 'alice'],
        [['--user=alice'], 'alice'],
        [['task', 'list', '--user', 'alice'], 'alice'],
        [['--user', 'alice@example.com'], 'alice@example.com'],
        [['--user=alice@example.com'], 'alice@example.com'],
    ] as const)('parses %j -> %j', (argv, expected) => {
        expect(parseGlobalArgs([...argv]).user).toBe(expected)
    })

    it.each([
        // absent
        [[] as readonly string[]],
        // bare at end of argv
        [['--user']],
        // followed by another long flag
        [['--user', '--json']],
        // followed by another short flag
        [['--user', '-v']],
        // followed by -- terminator
        [['--user', '--']],
        // empty equals form
        [['--user=']],
    ] as const)('leaves user undefined for %j', (argv) => {
        expect(parseGlobalArgs([...argv]).user).toBeUndefined()
    })

    it('does not consume --user after the -- terminator', () => {
        expect(parseGlobalArgs(['--', '--user', 'alice']).user).toBeUndefined()
    })

    it('coexists with other global flags', () => {
        expect(parseGlobalArgs(['--json', '--user', 'alice'])).toMatchObject({
            json: true,
            user: 'alice',
        })
    })
})

describe('stripUserFlag', () => {
    it.each([
        // pre-subcommand --user is stripped
        [['--user', 'alice'], []],
        [['--user=alice'], []],
        [
            ['--json', '--user', 'alice', '--ndjson'],
            ['--json', '--ndjson'],
        ],
        // bare --user followed by another flag (don't consume the flag)
        [['--user', '--json'], ['--json']],
        // bare --user at end (no value to consume)
        [['--user'], []],
    ] as const)('strips pre-subcommand %j -> %j', (argv, expected) => {
        expect(stripUserFlag([...argv])).toEqual(expected)
    })

    it.each([
        // Subcommand-level --user is left alone — the auth attachers parse it
        // there. Stripping it would route every `<sub> --user alice` to the
        // default account.
        [
            ['task', 'list', '--user', 'alice'],
            ['task', 'list', '--user', 'alice'],
        ],
        [
            ['task', 'list', '--user=alice'],
            ['task', 'list', '--user=alice'],
        ],
        [
            ['auth', 'status', '--user', 'alice'],
            ['auth', 'status', '--user', 'alice'],
        ],
        // bare --user at end of subcommand args
        [
            ['task', 'list', '--user'],
            ['task', 'list', '--user'],
        ],
    ] as const)('preserves subcommand-level --user verbatim: %j', (argv, expected) => {
        expect(stripUserFlag([...argv])).toEqual(expected)
    })

    it('strips pre-subcommand --user but keeps the subcommand-level one', () => {
        expect(
            stripUserFlag(['--json', '--user', 'alice', 'auth', 'status', '--user', 'bob']),
        ).toEqual(['--json', 'auth', 'status', '--user', 'bob'])
    })

    it('preserves everything after the -- terminator verbatim', () => {
        expect(stripUserFlag(['--user', 'alice', '--', '--user', 'literal'])).toEqual([
            '--',
            '--user',
            'literal',
        ])
    })

    it('does not mutate the input array', () => {
        const argv = ['--user', 'alice', 'task', 'list']
        const snapshot = [...argv]
        stripUserFlag(argv)
        expect(argv).toEqual(snapshot)
    })
})

describe('progressJsonl helpers', () => {
    it.each([
        [[], false, undefined],
        [['--progress-jsonl'], true, undefined],
        [['--progress-jsonl=/tmp/out'], true, '/tmp/out'],
    ] as const)('argv %j -> enabled=%j path=%j', (argv, enabled, path) => {
        const args = parseGlobalArgs([...argv])
        expect(isProgressJsonlEnabled(args)).toBe(enabled)
        expect(getProgressJsonlPath(args)).toBe(path)
    })
})

describe('createGlobalArgsStore', () => {
    const originalArgv = process.argv
    afterEach(() => {
        process.argv = originalArgv
    })

    it('caches across calls and re-parses after reset', () => {
        process.argv = ['node', 'cli', '--json']
        const store = createGlobalArgsStore()
        expect(store.get().json).toBe(true)
        process.argv = ['node', 'cli']
        expect(store.get().json).toBe(true) // still cached
        store.reset()
        expect(store.get().json).toBe(false) // re-parsed
    })

    it('threads custom-parser fields through the cached value', () => {
        type Extended = GlobalArgs & { user: string | undefined }
        const store = createGlobalArgsStore<Extended>(() => ({
            ...parseGlobalArgs(['--json']),
            user: 'scott@doist.com',
        }))
        expect(store.get()).toMatchObject({ json: true, user: 'scott@doist.com' })
    })
})

describe('createAccessibleGate', () => {
    afterEach(() => {
        vi.unstubAllEnvs()
    })

    it.each([
        // env, argv, expected
        ['1', [], true],
        [undefined, ['--accessible'], true],
        ['true', [], false], // non-"1" env values do not force accessible
        [undefined, [], false],
    ] as const)('env=%j argv=%j -> %j', (env, argv, expected) => {
        if (env !== undefined) vi.stubEnv('CORE_TEST_ACCESSIBLE', env)
        const gate = createAccessibleGate({
            envVar: 'CORE_TEST_ACCESSIBLE',
            getArgs: () => parseGlobalArgs([...argv]),
        })
        expect(gate()).toBe(expected)
    })
})

describe('createSpinnerGate', () => {
    afterEach(() => {
        vi.unstubAllEnvs()
    })

    function gateWith(argv: string[] = [], extraTriggers?: () => boolean) {
        return createSpinnerGate({
            envVar: 'CORE_TEST_SPINNER',
            getArgs: () => parseGlobalArgs(argv),
            extraTriggers,
        })
    }

    it('returns false when no trigger fires', () => {
        vi.stubEnv('CI', undefined)
        expect(gateWith()()).toBe(false)
    })

    it.each([
        ['--json'],
        ['--ndjson'],
        ['--no-spinner'],
        ['--progress-jsonl'],
        ['--verbose'],
        ['-v'],
        ['-vq'],
    ])('disables for %s', (flag) => {
        vi.stubEnv('CI', undefined)
        expect(gateWith([flag])()).toBe(true)
    })

    it.each([['--quiet'], ['-q'], ['--accessible']])('does not disable for %s', (flag) => {
        vi.stubEnv('CI', undefined)
        expect(gateWith([flag])()).toBe(false)
    })

    it('disables on env="false"', () => {
        vi.stubEnv('CORE_TEST_SPINNER', 'false')
        expect(gateWith()()).toBe(true)
    })

    it('disables under CI', () => {
        vi.stubEnv('CI', 'true')
        expect(gateWith()()).toBe(true)
    })

    it('passes extraTriggers result through when nothing else fires', () => {
        vi.stubEnv('CI', undefined)
        expect(gateWith([], () => true)()).toBe(true)
        expect(gateWith([], () => false)()).toBe(false)
    })

    it.each([
        ['env', () => vi.stubEnv('CORE_TEST_SPINNER', 'false'), [] as string[]],
        ['CI', () => vi.stubEnv('CI', 'true'), [] as string[]],
        ['canonical flag', () => vi.stubEnv('CI', undefined), ['--json']],
    ] as const)('does not call extraTriggers when %s already disables', (_label, setup, argv) => {
        setup()
        const extra = vi.fn(() => false)
        const gate = createSpinnerGate({
            envVar: 'CORE_TEST_SPINNER',
            getArgs: () => parseGlobalArgs([...argv]),
            extraTriggers: extra,
        })
        expect(gate()).toBe(true)
        expect(extra).not.toHaveBeenCalled()
    })
})
