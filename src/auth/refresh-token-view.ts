import type { Command } from 'commander'
import { CliError } from '../errors.js'
import { isStdoutTTY } from '../terminal.js'
import type { AuthAccount, TokenStore } from './types.js'
import { accountNotFoundError, attachUserFlag, extractUserRef } from './user-flag.js'

export type AttachRefreshTokenViewCommandOptions<TAccount extends AuthAccount = AuthAccount> = {
    store: TokenStore<TAccount>
    /** Parent subcommand name. Defaults to `'refresh-token'`. */
    groupName?: string
    groupDescription?: string
    /** View subcommand name. Defaults to `'view'`. */
    name?: string
    description?: string
}

/**
 * Attach a "print the saved refresh token" subcommand to `parent`. By default
 * this creates `<parent> refresh-token view`. Writes the bare refresh token to
 * stdout with no envelope so the output is pipe-safe. Throws
 * `CliError('AUTH_REFRESH_UNAVAILABLE', ...)` when the store cannot read full
 * bundles or the matched credential has no refresh token.
 */
export function attachRefreshTokenViewCommand<TAccount extends AuthAccount = AuthAccount>(
    parent: Command,
    options: AttachRefreshTokenViewCommandOptions<TAccount>,
): Command {
    const group = parent
        .command(options.groupName ?? 'refresh-token')
        .description(options.groupDescription ?? 'Manage the saved refresh token')
    const command = group
        .command(options.name ?? 'view')
        .description(options.description ?? 'Print the saved refresh token')

    return attachUserFlag(command).action(async (cmd: Record<string, unknown>) => {
        if (!options.store.activeBundle) {
            throw new CliError(
                'AUTH_REFRESH_UNAVAILABLE',
                'TokenStore must implement activeBundle to view refresh tokens.',
            )
        }

        const ref = extractUserRef(cmd)
        const snapshot = await options.store.activeBundle(ref)
        if (!snapshot) {
            if (ref !== undefined) throw accountNotFoundError(ref)
            throw new CliError('NOT_AUTHENTICATED', 'Not signed in.')
        }

        if (!snapshot.bundle.refreshToken) {
            throw new CliError(
                'AUTH_REFRESH_UNAVAILABLE',
                'Stored credential has no refresh token.',
            )
        }

        process.stdout.write(snapshot.bundle.refreshToken)
        if (isStdoutTTY()) process.stdout.write('\n')
    })
}
