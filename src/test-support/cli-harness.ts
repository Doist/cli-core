import type { Command } from 'commander'

import { createTestProgram } from '../testing/program.js'

// Shared test scaffolding for the Commander attacher suites. Internal-only
// (under `src/test-support/`, excluded from the build). Console/stdout spies
// live in the published `@doist/cli-core/testing` surface — import
// `captureConsole`/`captureStream` from `../testing/console.js` directly.

/**
 * Build a Commander program with `exitOverride()` and a single named parent
 * subcommand to attach to — the boilerplate every attacher suite repeats.
 */
export function buildProgram(parentName: string): { program: Command; parent: Command } {
    let parent!: Command
    const program = createTestProgram((p) => {
        parent = p.command(parentName)
    })
    return { program, parent }
}
