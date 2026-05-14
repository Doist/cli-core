import type { Command } from 'commander'
import type { AccountRef } from './types.js'

/**
 * Shared `--user <ref>` wiring for the account-touching auth attachers
 * (`attachLogoutCommand` / `attachStatusCommand` / `attachTokenViewCommand`).
 *
 * Internal — not re-exported from the auth subpath entry. The flag wording
 * and ref-extraction rule live in one place so the three call sites can't
 * drift if either changes.
 */

const USER_FLAG = '--user <ref>'
const USER_FLAG_DESCRIPTION = 'Target a specific stored account by id or label'

/** Attach the canonical `--user <ref>` option to `command` and return it. */
export function attachUserFlag(command: Command): Command {
    return command.option(USER_FLAG, USER_FLAG_DESCRIPTION)
}

/**
 * Normalise the `user` field of a Commander-parsed options object into an
 * `AccountRef`. Returns `undefined` when the flag was absent or supplied
 * without a value.
 */
export function extractUserRef(cmd: Record<string, unknown>): AccountRef | undefined {
    return typeof cmd.user === 'string' ? cmd.user : undefined
}
