import type { Command } from 'commander'
import { beforeEach } from 'vitest'

import { captureConsole, captureStream } from '../testing/console.js'
import { createTestProgram } from '../testing/program.js'

// Shared test scaffolding for the Commander attacher suites. Internal-only
// (under `src/test-support/`, excluded from the build). These thin wrappers
// own the per-test `beforeEach` lifecycle over the published `captureConsole` /
// `captureStream` helpers (which self-restore via `onTestFinished`), so the
// attacher suites declare a spy once per `describe` instead of repeating the
// `let spy` + `beforeEach` dance.

type Spy = ReturnType<typeof captureConsole>

function installCaptured(make: () => Spy): () => Spy {
    let spy: Spy
    beforeEach(() => {
        spy = make()
    })
    return () => spy
}

export function installCapturedConsole(method?: Parameters<typeof captureConsole>[0]): () => Spy {
    return installCaptured(() => captureConsole(method))
}

export function installCapturedStream(stream?: Parameters<typeof captureStream>[0]): () => Spy {
    return installCaptured(() => captureStream(stream))
}

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
