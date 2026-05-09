import type { Command } from 'commander'
import { CliError } from '../../errors.js'
import type { SpinnerOptions } from '../../spinner.js'
import { assertValidPort } from '../callback-server.js'
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
import {
    runTokenSet,
    runTokenView,
    type TokenSetCmdOptions,
    type TokenViewCmdOptions,
} from './token.js'

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
        /** Optional CLI flag spec to override the port. Default `'--callback-port <port>'`. */
        flagSpec?: string
        /** Optional env var name that overrides the port (CLI flag still wins). */
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
 * Register `login`, `logout`, `status`, `token` (with `token set`) on a
 * Commander program. Mirrors the `registerUpdateCommand` /
 * `registerChangelogCommand` pattern: one call wires every subcommand the
 * standard auth surface needs.
 *
 * `flat: true` matches todoist-cli/twist-cli (top-level `td login`, …);
 * `flat: false` (default) nests under `<cli> auth` to match outline-cli.
 *
 * `token set` reads the token from piped stdin — never argv — to comply with
 * Doist's secrets-management standard.
 *
 * Errors as `CliError` (`AUTH_*` codes plus the canonical `CONFIG_*` codes
 * when the config file is broken). The consumer's top-level handler is
 * expected to format and exit.
 */
export function registerAuthCommand<TAccount extends AuthAccount>(
    program: Command,
    options: RegisterAuthCommandOptions<TAccount>,
): void {
    const envTokenVar = options.envTokenVar ?? `${options.appName.toUpperCase()}_API_TOKEN`
    const portFlagSpec = options.callbackPort.flagSpec ?? '--callback-port <port>'
    const portEnvOverride = resolveEnvPort(options.callbackPort.envVar)

    const root = options.flat
        ? program
        : program
              .command(options.commandName ?? 'auth')
              .description(`Manage ${options.displayName} authentication`)

    // login — OAuth only. Manual token entry lives in `token set`.
    const loginCommand = withViewOptions(
        root
            .command('login')
            .description(`Sign in to ${options.displayName}`)
            .option('--read-only', 'Request read-only scopes')
            .option(portFlagSpec, 'Override the local OAuth callback port', parsePortFlag),
    )
    attachLoginFlags(loginCommand, options.loginFlags)

    loginCommand.action(async (cmdOptions: LoginCmdOptions) => {
        // Precedence: explicit CLI flag > env override > registered preferred port.
        const port = cmdOptions.callbackPort ?? portEnvOverride ?? options.callbackPort.preferred
        assertValidPort(port, 'callback port')
        await runLogin<TAccount>(
            {
                provider: options.provider,
                store: options.store,
                displayName: options.displayName,
                resolveScopes: options.resolveScopes,
                callbackPort: {
                    preferred: port,
                    fallbackCount: options.callbackPort.fallbackCount,
                },
                renderSuccess: options.renderSuccess,
                renderError: options.renderError,
                openBrowser: options.openBrowser,
                withSpinner: options.withSpinner,
            },
            { ...cmdOptions, callbackPort: port },
        )
    })

    // logout
    withViewOptions(
        root
            .command('logout')
            .description(`Sign out of ${options.displayName}`)
            .option('--user <id>', 'Sign out of a specific stored account id')
            .option('--all', 'Clear every stored credential'),
    ).action(async (cmdOptions: LogoutCmdOptions) => {
        await runLogout<TAccount>(
            { store: options.store, displayName: options.displayName },
            cmdOptions,
        )
    })

    // status
    withViewOptions(
        root
            .command('status')
            .description(`Show ${options.displayName} authentication status`)
            .option('--user <id>', 'Show a specific stored account id'),
    ).action(async (cmdOptions: StatusCmdOptions) => {
        await runStatus<TAccount>(
            { store: options.store, displayName: options.displayName, envTokenVar },
            cmdOptions,
        )
    })

    // token (default action: view)
    const tokenCommand = withViewOptions(
        root
            .command('token')
            .description(`Print or set the ${options.displayName} API token`)
            .option('--user <id>', 'Show a specific stored account id'),
    ).action(async (cmdOptions: TokenViewCmdOptions) => {
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

    withViewOptions(
        tokenCommand
            .command('set')
            .description('Save a token from piped stdin without going through the OAuth flow'),
    ).action(async (cmdOptions: TokenSetCmdOptions) => {
        await runTokenSet<TAccount>(
            {
                provider: options.provider,
                store: options.store,
                displayName: options.displayName,
                envTokenVar,
            },
            cmdOptions,
        )
    })
}

/** Append the canonical `--json` / `--ndjson` machine-output flags. */
function withViewOptions(cmd: Command): Command {
    return cmd
        .option('--json', 'Emit machine-readable JSON output')
        .option('--ndjson', 'Emit machine-readable NDJSON output')
}

function attachLoginFlags(cmd: Command, specs: ReadonlyArray<LoginFlagSpec> | undefined): void {
    if (!specs) return
    for (const spec of specs) {
        if (spec.parse) {
            cmd.option(spec.flags, spec.description, spec.parse, spec.defaultValue)
        } else if (spec.defaultValue !== undefined) {
            cmd.option(spec.flags, spec.description, spec.defaultValue as string)
        } else {
            cmd.option(spec.flags, spec.description)
        }
    }
}

function parsePortFlag(value: string): number {
    const parsed = Number.parseInt(value, 10)
    if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
        throw new CliError(
            'AUTH_PORT_BIND_FAILED',
            `Invalid --callback-port '${value}': expected an integer in [0..65535].`,
        )
    }
    return parsed
}

function resolveEnvPort(envVar: string | undefined): number | undefined {
    if (!envVar) return undefined
    const raw = process.env[envVar]
    if (!raw) return undefined
    const parsed = Number.parseInt(raw, 10)
    if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
        throw new CliError(
            'AUTH_PORT_BIND_FAILED',
            `Invalid ${envVar}='${raw}': expected an integer in [0..65535].`,
        )
    }
    return parsed
}
