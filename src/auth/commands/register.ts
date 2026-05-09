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

type WithSpinner = <T>(options: SpinnerOptions, op: () => Promise<T>) => Promise<T>

export type RegisterAuthCommandOptions<TAccount extends AuthAccount = AuthAccount> = {
    /** Display name in user-facing output (`'Outline'`, `'Todoist'`, …). */
    displayName: string
    provider: AuthProvider<TAccount>
    store: TokenStore<TAccount>
    /**
     * Resolve scope list per call. Receives `readOnly` (from `--read-only`)
     * and the remaining flags bag (CLI-declared flags + reserved cli-core
     * flags stripped).
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
    /** Per-CLI extra flags surfaced on `login`. */
    loginFlags?: LoginFlagSpec[]
    /** When true, register `login` at the program top level instead of nested under an `auth` parent. */
    flat?: boolean
    /** Parent command name when not `flat`. Default `'auth'`. */
    commandName?: string
    /** Spinner runner from `createSpinner()`. */
    withSpinner?: WithSpinner
    /** Override the browser opener (tests). */
    openBrowser?: (url: string) => Promise<void>
}

/**
 * Register the `login` subcommand on a Commander program. Mirrors the
 * `registerUpdateCommand` / `registerChangelogCommand` pattern: one call
 * wires the OAuth-driving subcommand and threads provider + store + scope
 * resolution through to the runtime.
 *
 * `flat: true` puts `login` at the program top level (matching todoist-cli /
 * twist-cli); `flat: false` (default) nests under `<cli> auth login` (matching
 * outline-cli).
 *
 * `logout`, `status`, and `token` are intentionally not extracted — those
 * surfaces are short and currently CLI-specific in shape, so each CLI keeps
 * its own implementations until a concrete migration proves them worth
 * sharing.
 *
 * Errors as `CliError` (`AUTH_*` codes plus the canonical `CONFIG_*` codes
 * when the config file is broken). The consumer's top-level handler is
 * expected to format and exit.
 */
export function registerAuthCommand<TAccount extends AuthAccount>(
    program: Command,
    options: RegisterAuthCommandOptions<TAccount>,
): void {
    const portFlagSpec = options.callbackPort.flagSpec ?? '--callback-port <port>'
    const portFlagAttr = deriveFlagAttribute(portFlagSpec)

    const root = options.flat
        ? program
        : program
              .command(options.commandName ?? 'auth')
              .description(`Manage ${options.displayName} authentication`)

    const loginCommand = root
        .command('login')
        .description(`Sign in to ${options.displayName}`)
        .option('--read-only', 'Request read-only scopes')
        .option(portFlagSpec, 'Override the local OAuth callback port', parsePortFlag)
        .option('--json', 'Emit machine-readable JSON output')
        .option('--ndjson', 'Emit machine-readable NDJSON output')
    attachLoginFlags(loginCommand, options.loginFlags)

    loginCommand.action(async (cmdOptions: LoginCmdOptions) => {
        // Defer env-var validation to action time so a malformed env var only
        // surfaces on the command that actually needs it.
        const envOverride = resolveEnvPort(options.callbackPort.envVar)
        // Precedence: explicit CLI flag > env override > registered preferred port.
        // Read the CLI flag through its derived attribute name so a custom
        // flagSpec (e.g. `--oauth-port <port>`) still resolves correctly.
        const cliPort = (cmdOptions as Record<string, unknown>)[portFlagAttr] as number | undefined
        const port = cliPort ?? envOverride ?? options.callbackPort.preferred
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
            cmdOptions,
            { reservedFlagAttrs: [portFlagAttr] },
        )
    })
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

/**
 * Mirror Commander's own attribute-name derivation for a long flag spec:
 * strip the `--` prefix, drop any `<value>` / `[value]` suffix, camelCase
 * the kebab-case remainder. `--callback-port <port>` → `callbackPort`.
 */
function deriveFlagAttribute(spec: string): string {
    const long = spec
        .split(/\s+/)
        .find((part) => part.startsWith('--'))
        ?.slice(2)
    if (!long) {
        throw new Error(
            `flagSpec '${spec}' must contain a long flag (e.g. '--callback-port <port>')`,
        )
    }
    return long.replace(/-([a-z])/g, (_, ch: string) => ch.toUpperCase())
}

function parsePortFlag(value: string): number {
    const port = parsePortString(value)
    if (port === null) {
        throw new CliError(
            'AUTH_PORT_BIND_FAILED',
            `Invalid --callback-port '${value}': expected an integer in [0..65535].`,
        )
    }
    return port
}

function resolveEnvPort(envVar: string | undefined): number | undefined {
    if (!envVar) return undefined
    const raw = process.env[envVar]
    if (!raw) return undefined
    const port = parsePortString(raw)
    if (port === null) {
        throw new CliError(
            'AUTH_PORT_BIND_FAILED',
            `Invalid ${envVar}='${raw}': expected an integer in [0..65535].`,
        )
    }
    return port
}

/**
 * Strict-integer port parser — `Number.parseInt` would silently accept
 * `'123abc'` / `'1.5'`, masking caller mistakes that surface much later as
 * raw bind errors.
 */
function parsePortString(raw: string): number | null {
    if (!/^\d+$/.test(raw)) return null
    const port = Number(raw)
    return port >= 0 && port <= 65535 ? port : null
}
