import type { Command } from 'commander'
import { CliError } from '../errors.js'
import { isStdoutTTY } from '../terminal.js'
import type { AuthAccount, TokenStore } from './types.js'
import { attachUserFlag, extractUserRef, requireSnapshotForRef } from './user-flag.js'

export type AttachTokenViewCommandOptions<TAccount extends AuthAccount = AuthAccount> = {
    store: TokenStore<TAccount>
    /** Subcommand name. Defaults to `'token'`. Pass `'view'` to nest under an existing `token` group. */
    name?: string
    description?: string
    /**
     * When set, refuses to print if `process.env[envVarName]` is populated.
     * Guards against disclosing a token the CLI didn't manage — the env var
     * typically takes precedence over the stored token elsewhere in the CLI,
     * so printing the stored token here would be misleading at best.
     */
    envVarName?: string
}

/**
 * Attach a "print the saved token" subcommand to `parent`. Writes the bare
 * token to stdout with no envelope so the output is pipe-safe (e.g. `eval $(td
 * auth token)`). Throws `CliError('TOKEN_FROM_ENV', …)` when `envVarName` is
 * set and the env var is populated, and `CliError('NOT_AUTHENTICATED', …)`
 * when no token is stored. Returns the new `Command` for chaining.
 */
export function attachTokenViewCommand<TAccount extends AuthAccount = AuthAccount>(
    parent: Command,
    options: AttachTokenViewCommandOptions<TAccount>,
): Command {
    const command = parent
        .command(options.name ?? 'token')
        .description(options.description ?? 'Print the saved authentication token')
    return attachUserFlag(command).action(async (cmd: Record<string, unknown>) => {
        if (options.envVarName && process.env[options.envVarName]) {
            throw new CliError(
                'TOKEN_FROM_ENV',
                `Refusing to print: token is being read from $${options.envVarName}, not the saved store.`,
                {
                    hints: [
                        `Unset ${options.envVarName} to view the stored token.`,
                        'The env var takes precedence over saved tokens; printing it would disclose a secret the CLI did not manage.',
                    ],
                },
            )
        }
        const ref = extractUserRef(cmd)
        const snapshot = await requireSnapshotForRef(options.store, ref)
        if (!snapshot) {
            throw new CliError('NOT_AUTHENTICATED', 'Not signed in.')
        }
        process.stdout.write(snapshot.token)
        if (isStdoutTTY()) process.stdout.write('\n')
    })
}
