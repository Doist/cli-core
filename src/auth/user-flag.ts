import type { Command } from 'commander'
import { CliError } from '../errors.js'
import type { AccountRef, AuthAccount, TokenStore } from './types.js'

// Shared `--user <ref>` wiring + snapshot-or-throw helper so the three auth
// attachers can't drift on flag wording or miss semantics. Internal — not
// re-exported.

const USER_FLAG = '--user <ref>'
const USER_FLAG_DESCRIPTION = 'Target a specific stored account'

export function attachUserFlag(command: Command): Command {
    return command.option(USER_FLAG, USER_FLAG_DESCRIPTION)
}

/** `cmd.user` as an `AccountRef`, or `undefined` when absent. */
export function extractUserRef(cmd: Record<string, unknown>): AccountRef | undefined {
    return typeof cmd.user === 'string' ? cmd.user : undefined
}

/** Shared constructor so multiple call sites can't drift on the `ACCOUNT_NOT_FOUND` wording. */
export function accountNotFoundError(ref: AccountRef): CliError {
    return new CliError('ACCOUNT_NOT_FOUND', `No stored account matches "${ref}".`)
}

/**
 * Read `store.active(ref)` and throw `ACCOUNT_NOT_FOUND` if the explicit
 * `ref` doesn't match. With `ref === undefined` returns the snapshot
 * (possibly `null`) unchanged.
 */
export async function requireSnapshotForRef<TAccount extends AuthAccount>(
    store: TokenStore<TAccount>,
    ref: AccountRef | undefined,
): Promise<{ token: string; account: TAccount } | null> {
    const snapshot = await store.active(ref)
    if (ref !== undefined && snapshot === null) {
        throw accountNotFoundError(ref)
    }
    return snapshot
}
