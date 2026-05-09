import type { Command } from 'commander'
import type { SpinnerOptions } from '../../spinner.js'
import type {
    AuthAccount,
    AuthProvider,
    ErrorContext,
    LoginFlagSpec,
    SuccessContext,
    TokenStore,
} from '../types.js'
import { type LoginCmdOptions, runLogin } from './login.js'
import { type LogoutCmdOptions, runLogout } from './logout.js'
import { type StatusCmdOptions, runStatus } from './status.js'
import { runTokenSet, runTokenView, type TokenViewCmdOptions } from './token.js'

type WithSpinner = <T>(options: SpinnerOptions, op: () => Promise<T>) => Promise<T>

export type RegisterAuthCommandOptions<TAccount extends AuthAccount = AuthAccount> = {
    /** Used in the default env-token var (`<APP>_API_TOKEN`) and Commander metavars. */
    appName: string
    /** Display name in user-facing output (`'Todoist'`, `'Twist'`, …). */
    displayName: string
    provider: AuthProvider<TAccount>
    store: TokenStore<TAccount>
    /**
     * Resolve scope list per call. Receives `readOnly` (from `--read-only`) and
     * the remaining flags bag (CLI-declared flags + reserved cli-core flags
     * stripped).
     */
    resolveScopes: (ctx: { readOnly: boolean; flags: Record<string, unknown> }) => string[]
    callbackPort: {
        /** Preferred port. */
        preferred: number
        /** Walk up this many ports if `preferred` is busy. Default 5. */
        fallbackCount?: number
        /** Optional CLI flag to override the port. Default `'--callback-port <port>'` (omit to disable). */
        flagSpec?: string
        /** Optional env var name that overrides the port. */
        envVar?: string
    }
    renderSuccess: (ctx: SuccessContext) => string
    renderError: (ctx: ErrorContext) => string
    /** Override the env var name. Default `'<APPNAME>_API_TOKEN'`. */
    envTokenVar?: string
    /** Per-CLI extra flags surfaced on `login`. */
    loginFlags?: LoginFlagSpec[]
    /** When true, register `login` / `logout` / `status` / `token` at the program top level instead of nested under an `auth` parent. */
    flat?: boolean
    /** Parent command name when not `flat`. Default `'auth'`. */
    commandName?: string
    /** Spinner runner from `createSpinner()`. */
    withSpinner?: WithSpinner
    /** Override the browser opener (tests). */
    openBrowser?: (url: string) => Promise<void>
}

/**
 * Register `login`, `logout`, `status`, `token` (with `token set <value>`) on a
 * Commander program. Mirrors the `registerUpdateCommand` / `registerChangelogCommand`
 * pattern: one call wires every subcommand the standard auth surface needs.
 *
 * `flat: true` matches todoist-cli/twist-cli (top-level `td login`, `td logout`,
 * …); `flat: false` (default) nests under `<cli> auth` to match outline-cli.
 *
 * Errors as `CliError` (`AUTH_*` codes plus the canonical `CONFIG_*` codes when
 * the config file is broken). The consumer's top-level handler is expected to
 * format and exit.
 */
export function registerAuthCommand<TAccount extends AuthAccount>(
    program: Command,
    options: RegisterAuthCommandOptions<TAccount>,
): void {
    const envTokenVar = options.envTokenVar ?? `${options.appName.toUpperCase()}_API_TOKEN`
    const portFlagSpec = options.callbackPort.flagSpec ?? '--callback-port <port>'
    const portEnvOverride = options.callbackPort.envVar
        ? Number.parseInt(process.env[options.callbackPort.envVar] ?? '', 10)
        : Number.NaN

    const root = options.flat
        ? program
        : program
              .command(options.commandName ?? 'auth')
              .description(`Manage ${options.displayName} authentication`)

    // login
    const loginCommand = root
        .command('login')
        .description(`Sign in to ${options.displayName}`)
        .option('--read-only', 'Request read-only scopes')
        .option('--token <value>', 'Skip the OAuth flow and save the supplied token directly')
        .option(portFlagSpec, 'Override the local OAuth callback port', (v) =>
            Number.parseInt(v, 10),
        )
        .option('--user <id>', 'Sign in as a specific stored account id (multi-user only)')
        .option('--json', 'Emit machine-readable JSON output')
        .option('--ndjson', 'Emit machine-readable NDJSON output')

    if (options.loginFlags) {
        for (const spec of options.loginFlags) {
            if (spec.parse) {
                loginCommand.option(spec.flags, spec.description, spec.parse, spec.defaultValue)
            } else if (spec.defaultValue !== undefined) {
                loginCommand.option(spec.flags, spec.description, spec.defaultValue as string)
            } else {
                loginCommand.option(spec.flags, spec.description)
            }
        }
    }

    loginCommand.action(async (cmdOptions: LoginCmdOptions) => {
        const flags = mapLoginFlags(cmdOptions, options.loginFlags ?? [])
        const port = Number.isFinite(portEnvOverride) ? portEnvOverride : cmdOptions.callbackPort
        await runLogin<TAccount>(
            {
                provider: options.provider,
                store: options.store,
                displayName: options.displayName,
                resolveScopes: options.resolveScopes,
                callbackPort: {
                    preferred: options.callbackPort.preferred,
                    fallbackCount: options.callbackPort.fallbackCount,
                },
                renderSuccess: options.renderSuccess,
                renderError: options.renderError,
                openBrowser: options.openBrowser,
                withSpinner: options.withSpinner,
            },
            { ...cmdOptions, callbackPort: port, ...flags },
        )
    })

    // logout
    root.command('logout')
        .description(`Sign out of ${options.displayName}`)
        .option('--user <id>', 'Sign out of a specific stored account id')
        .option('--all', 'Clear every stored credential')
        .option('--json', 'Emit machine-readable JSON output')
        .option('--ndjson', 'Emit machine-readable NDJSON output')
        .action(async (cmdOptions: LogoutCmdOptions) => {
            await runLogout<TAccount>(
                { store: options.store, displayName: options.displayName },
                cmdOptions,
            )
        })

    // status
    root.command('status')
        .description(`Show ${options.displayName} authentication status`)
        .option('--user <id>', 'Show a specific stored account id')
        .option('--json', 'Emit machine-readable JSON output')
        .option('--ndjson', 'Emit machine-readable NDJSON output')
        .action(async (cmdOptions: StatusCmdOptions) => {
            await runStatus<TAccount>(
                { store: options.store, displayName: options.displayName, envTokenVar },
                cmdOptions,
            )
        })

    // token (default action: view)
    const tokenCommand = root
        .command('token')
        .description(`Print or set the ${options.displayName} API token`)
        .option('--user <id>', 'Show a specific stored account id')
        .option('--json', 'Emit machine-readable JSON output')
        .option('--ndjson', 'Emit machine-readable NDJSON output')
        .action(async (cmdOptions: TokenViewCmdOptions) => {
            await runTokenView<TAccount>(
                {
                    provider: options.provider,
                    store: options.store,
                    displayName: options.displayName,
                    envTokenVar,
                },
                cmdOptions,
            )
        })

    tokenCommand
        .command('set <value>')
        .description('Save a token directly without going through the OAuth flow')
        .option('--json', 'Emit machine-readable JSON output')
        .option('--ndjson', 'Emit machine-readable NDJSON output')
        .action(async (value: string, cmdOptions: { json?: boolean; ndjson?: boolean }) => {
            await runTokenSet<TAccount>(
                {
                    provider: options.provider,
                    store: options.store,
                    displayName: options.displayName,
                    envTokenVar,
                },
                value,
                cmdOptions,
            )
        })
}

function mapLoginFlags(cmd: LoginCmdOptions, specs: LoginFlagSpec[]): Record<string, unknown> {
    const result: Record<string, unknown> = {}
    for (const spec of specs) {
        const value = cmd[spec.key]
        if (value !== undefined) result[spec.key] = value
    }
    return result
}
