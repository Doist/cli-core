import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf8')) as {
    exports?: Record<string, { types?: string; import?: string }>
}

describe('@doist/cli-core/testing subpath wiring', () => {
    it('declares ./testing in package.json exports with import + types', () => {
        const entry = pkg.exports?.['./testing']
        expect(entry).toBeDefined()
        expect(entry?.types).toMatch(/^\.\/dist\/.*\.d\.ts$/)
        expect(entry?.import).toMatch(/^\.\/dist\/.*\.js$/)
    })

    // Resolution through the package exports map can only be verified when
    // dist/ exists. CI runs `npm run build && npm test` so this fires there;
    // the typo-detection test above always runs.
    it.runIf(existsSync(resolve(repoRoot, 'dist')))(
        'resolves the declared ./testing dist files and exports the helper',
        async () => {
            const entry = pkg.exports?.['./testing']
            const importPath = resolve(repoRoot, entry?.import ?? '')
            const typesPath = resolve(repoRoot, entry?.types ?? '')
            expect(existsSync(importPath)).toBe(true)
            expect(existsSync(typesPath)).toBe(true)
            const mod = (await import(importPath)) as Record<string, unknown>
            expect(typeof mod.describeEmptyMachineOutput).toBe('function')
        },
    )
})
