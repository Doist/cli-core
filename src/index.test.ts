import { readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const SRC = dirname(fileURLToPath(import.meta.url))

const packageJson = JSON.parse(readFileSync(join(SRC, '..', 'package.json'), 'utf8')) as {
    peerDependenciesMeta?: Record<string, { optional?: boolean }>
}
const optionalPeers = Object.entries(packageJson.peerDependenciesMeta ?? {})
    .filter(([, meta]) => meta.optional)
    .map(([name]) => name)

/** Every source file the root entry reaches through relative imports, with its text. */
function rootEntrySources(): Map<string, string> {
    const sources = new Map<string, string>()
    const queue = [join(SRC, 'index.ts')]
    for (let file = queue.pop(); file !== undefined; file = queue.pop()) {
        if (sources.has(file)) continue
        const source = readFileSync(file, 'utf8')
        sources.set(file, source)
        for (const [, specifier] of source.matchAll(/from\s+'(\.[^']+)'/g)) {
            queue.push(resolve(dirname(file), specifier.replace(/\.js$/, '.ts')))
        }
    }
    return sources
}

describe('root entry', () => {
    // The root entry promises to work without any optional peer installed. A
    // type-only import still lands in the emitted `.d.ts`, so a consumer
    // without the peer gets `Cannot find module` from the type checker.
    it('imports no optional peer, not even for types', () => {
        const offenders: string[] = []
        for (const [file, source] of rootEntrySources()) {
            for (const [, specifier] of source.matchAll(/from\s+'([^.'][^']*)'/g)) {
                const peer = optionalPeers.find(
                    (name) => specifier === name || specifier.startsWith(`${name}/`),
                )
                if (peer) offenders.push(`${relative(SRC, file)} imports ${specifier}`)
            }
        }

        expect(optionalPeers).toContain('commander')
        expect(offenders).toEqual([])
    })
})
