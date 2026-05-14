import type { Command } from 'commander'
import type { AccountRef } from './types.js'

// Shared `--user <ref>` wiring so the three auth attachers can't drift on
// flag wording or ref normalisation. Internal — not re-exported.

const USER_FLAG = '--user <ref>'
const USER_FLAG_DESCRIPTION = 'Target a specific stored account by id or label'

export function attachUserFlag(command: Command): Command {
    return command.option(USER_FLAG, USER_FLAG_DESCRIPTION)
}

/** `cmd.user` as an `AccountRef`, or `undefined` when absent. */
export function extractUserRef(cmd: Record<string, unknown>): AccountRef | undefined {
    return typeof cmd.user === 'string' ? cmd.user : undefined
}
