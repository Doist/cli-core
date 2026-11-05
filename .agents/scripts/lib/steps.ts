import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { readJson } from './state.ts'
import type { Step } from './verify.ts'

const bin = (tool: string) => `node_modules/.bin/${tool}`

// GitHub Actions sets CI=true for every job. cli-core's `isCI()` reads it, and it makes vitest fail
// on `.only`, so checks run with it to match CI.
const CI_ENV = { CI: 'true' }

/** Every check the pull-request workflows in CHECKED_WORKFLOWS run, with one shared build. */
export const VERIFY_STEPS: Step[] = [
    { name: 'lint', command: bin('oxlint'), args: ['src', '.agents/scripts'] },
    { name: 'format', command: bin('oxfmt'), args: ['--check'] },
    { name: 'types', command: bin('tsc'), args: ['--noEmit'] },
    { name: 'types:tools', command: bin('tsc'), args: ['--noEmit', '-p', '.agents/scripts'] },
    { name: 'build', command: bin('tsc'), args: ['-p', 'tsconfig.build.json'], env: CI_ENV },
    // src/testing/subpath.test.ts imports the built ./testing entry from dist/ when it exists, as
    // in CI, so the tests start once the build has finished writing it.
    {
        name: 'tests',
        command: bin('vitest'),
        args: ['run', '--passWithNoTests'],
        env: CI_ENV,
        waitFor: ['build'],
    },
]

/**
 * How each `run:` in the checked workflows maps to verify steps. For an npm script, the steps
 * must run the script's commands, in order; steps.test.ts compares them with package.json and the
 * workflows, so CI and verify cannot drift apart silently. A step list left empty says why.
 */
export const CI_EQUIVALENTS: { run: string; steps: string[]; why?: string }[] = [
    { run: 'npm ci', steps: [], why: 'the preflight checks node_modules matches the lockfile' },
    { run: 'npm run type-check', steps: ['types', 'types:tools'] },
    { run: 'npm run check', steps: ['lint', 'format'] },
    { run: 'npm run build', steps: ['build'] },
    { run: 'npm test', steps: ['tests'] },
]

/**
 * Variables that change what the code under test does. CI never sets them, so verify removes them,
 * and the checks see what CI sees. A real GitHub token never reaches the tests either.
 */
export const LOCAL_ONLY_ENV = [
    'GH_TOKEN',
    'GITHUB_TOKEN',
    'BROWSER',
    'DISPLAY',
    'WAYLAND_DISPLAY',
    'FORCE_COLOR',
]

type PackageJson = {
    engines?: { node?: string }
    dependencies?: Record<string, string>
    devDependencies?: Record<string, string>
}
type Lockfile = {
    packages?: Record<
        string,
        {
            version?: string
            optional?: boolean
            devOptional?: boolean
            dependencies?: Record<string, string>
            devDependencies?: Record<string, string>
        }
    >
}

const MAX_LISTED = 10

/** Problems that would make the checks fail for reasons unrelated to the change. */
export function preflight(root: string, nodeVersion = process.versions.node): string[] {
    const problems: string[] = []
    const pkg = readJson<PackageJson>(join(root, 'package.json'))
    const minimum = pkg?.engines?.node?.match(/^>=\s*(\d+)/)?.[1]
    const major = Number(nodeVersion.split('.')[0])
    if (minimum && major < Number(minimum)) {
        problems.push(
            `Node ${nodeVersion} is older than the ${pkg?.engines?.node} this repository needs. ` +
                'Switch versions (see .nvmrc) and run again.',
        )
    }

    if (!existsSync(join(root, 'node_modules'))) {
        problems.push('node_modules is missing. Run `npm ci`.')
        return problems
    }
    const lock = readJson<Lockfile>(join(root, 'package-lock.json'))
    if (!lock?.packages) {
        problems.push('package-lock.json is missing or unreadable. Run `npm install`.')
        return problems
    }
    // npm ci refuses to install when package.json and the lockfile disagree, so CI would fail
    // before any check runs.
    const manifest = lock.packages[''] ?? {}
    const disagree: string[] = []
    for (const field of ['dependencies', 'devDependencies'] as const) {
        const wanted = pkg?.[field] ?? {}
        const locked = manifest[field] ?? {}
        for (const name of new Set([...Object.keys(wanted), ...Object.keys(locked)])) {
            if (wanted[name] !== locked[name]) {
                disagree.push(
                    `${name} (package.json: ${wanted[name] ?? 'none'}, lockfile: ${locked[name] ?? 'none'})`,
                )
            }
        }
    }
    if (disagree.length > 0) {
        problems.push(
            `package.json and package-lock.json disagree: ${disagree.join(', ')}. Run \`npm install\`.`,
        )
        return problems
    }

    // npm records the tree it installed in node_modules/.package-lock.json. Comparing every
    // package with the lockfile catches a transitive dependency that changed while every direct one
    // kept its version. Optional packages for other platforms are never installed.
    const installed = readJson<Lockfile>(join(root, 'node_modules/.package-lock.json'))?.packages
    if (!installed) {
        problems.push('node_modules has no record of what npm installed. Run `npm ci`.')
        return problems
    }
    const stale: string[] = []
    for (const [path, entry] of Object.entries(lock.packages)) {
        if (!path.startsWith('node_modules/')) continue
        const name = path.slice('node_modules/'.length)
        const version = installed[path]?.version
        if (version === undefined) {
            if (!entry.optional && !entry.devOptional) {
                stale.push(`${name} missing (lockfile: ${entry.version})`)
            }
        } else if (version !== entry.version) {
            stale.push(`${name} ${version} (lockfile: ${entry.version})`)
        }
    }
    if (stale.length > 0) {
        const shown = stale.slice(0, MAX_LISTED).join(', ')
        const more = stale.length > MAX_LISTED ? ` and ${stale.length - MAX_LISTED} more` : ''
        problems.push(
            `node_modules does not match package-lock.json: ${shown}${more}. Run \`npm ci\`.`,
        )
    }
    return problems
}

/** What verification cannot see, printed after every pass. */
export const BLIND_SPOTS = [
    'the CLIs that depend on this package (todoist-cli, twist-cli, outline-cli, comms-cli): try a build in one before changing shared behaviour',
    'the real OS keyring and a real browser OAuth flow',
    'the other Node version CI tests on (24 and 26); verify uses only yours',
]
