/**
 * Request headers that let Doist backends attribute API traffic to a CLI.
 *
 * Every Doist CLI sends the same set, so backend logs can tell CLI traffic
 * apart, see which version and OS it came from, pick out one request, group
 * the requests of one CLI run, and name the command that made them. No
 * identifying data is sent: the request and session IDs are random UUIDs, and
 * the session ID lives only as long as its tracker. A CLI creates one tracker
 * per process, so the session ID groups the requests of one run.
 *
 * `request-id` is separate from the `X-Request-Id` the Doist SDKs send on some
 * writes. That one is an idempotency key the caller controls, so it is absent
 * on most requests and must not be reused for tracing.
 */

import { randomUUID } from 'node:crypto'

/**
 * The part of a Commander `Command` that labelling reads. Structural, so the
 * root entry keeps working, types included, without the optional `commander`
 * peer; a real `Command` satisfies it as is.
 */
export type CommandLike = {
    name(): string
    readonly parent: CommandLike | null
}

export type UsageTrackingOptions = {
    /** Product name sent in the `User-Agent`, for example `todoist-cli`. */
    cliName: string
    /** The CLI's own version, sent as `doist-version` and in the `User-Agent`. */
    version: string
}

export type UsageHeadersOptions = {
    /**
     * Attributes this request to a command other than the active one, for
     * work that runs outside Commander (for example a postinstall step).
     */
    command?: string
}

export type UsageTracking = {
    /**
     * Records the command responsible for later requests. A Commander
     * command (as a `preAction` hook receives it) is labelled by its path
     * below the program, so `td task add` becomes `task:add`. A string is
     * taken as the label itself. `undefined` clears it.
     */
    setCommand(command: CommandLike | string | undefined): void
    /** The usage headers for one request, with a fresh `request-id` each call. */
    headers(options?: UsageHeadersOptions): Record<string, string>
    /**
     * Merges the usage headers into a request's own headers. The usage
     * headers win over a caller header of the same name, in any case. Keys
     * come back lower-cased, as `Headers` normalises them.
     */
    mergeHeaders(init?: HeadersInit, options?: UsageHeadersOptions): Record<string, string>
}

const UNKNOWN_COMMAND = 'unknown'

function getDoistOs(): 'macos' | 'linux' | 'windows' | 'unknown' {
    switch (process.platform) {
        case 'darwin':
            return 'macos'
        case 'linux':
            return 'linux'
        case 'win32':
            return 'windows'
        default:
            return 'unknown'
    }
}

// Lower-case and colon-separated keeps the label low-cardinality in backend
// logs: `Task View`, `task view` and `task:view` all land in one bucket.
function normaliseLabel(label: string): string {
    return label.trim().toLowerCase().replace(/\s+/g, ':')
}

function labelCommand(command: CommandLike | string): string {
    if (typeof command === 'string') return normaliseLabel(command)

    const names: string[] = []
    // The root program has no parent and its name is the binary, which every
    // request from this CLI shares, so it stays out of the label.
    for (let current: CommandLike | null = command; current?.parent; current = current.parent) {
        names.unshift(current.name())
    }
    return normaliseLabel(names.join(' '))
}

/**
 * Creates a tracker with its own session ID. Create one per process and share
 * it, so every request of a CLI run carries the same session ID.
 */
export function createUsageTracking(options: UsageTrackingOptions): UsageTracking {
    const userAgent = `${options.cliName}/${options.version}`
    const sessionId = randomUUID()
    let activeCommand: string | undefined

    function headers(headersOptions: UsageHeadersOptions = {}): Record<string, string> {
        const command =
            headersOptions.command !== undefined
                ? normaliseLabel(headersOptions.command)
                : activeCommand
        return {
            'User-Agent': userAgent,
            'doist-platform': 'cli',
            'doist-version': options.version,
            'doist-os': getDoistOs(),
            'request-id': randomUUID(),
            'session-id': sessionId,
            'cli-command': command || UNKNOWN_COMMAND,
        }
    }

    return {
        setCommand(command) {
            activeCommand = command === undefined ? undefined : labelCommand(command)
        },
        headers,
        mergeHeaders(init, headersOptions) {
            const merged = new Headers(init)
            for (const [name, value] of Object.entries(headers(headersOptions))) {
                merged.set(name, value)
            }
            return Object.fromEntries(merged.entries())
        },
    }
}
