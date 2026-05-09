import type { AuthErrorCode } from './auth/errors.js'
import type { CommandErrorCode } from './commands/errors.js'
import type { ConfigErrorCode } from './config.js'

export type ErrorType = 'error' | 'info'

export type CliErrorOptions = {
    hints?: string[]
    type?: ErrorType
}

/**
 * Aggregator of every error code that cli-core itself defines. Baked into the
 * `CliError` constructor so consumers don't have to redeclare these strings in
 * their own `ErrorCode` union — they're always accepted.
 *
 * Grows as future modules add their own well-known codes:
 *
 * ```ts
 * export type CliErrorCode = ConfigErrorCode | SpinnerErrorCode | …
 * ```
 */
export type CliErrorCode = AuthErrorCode | CommandErrorCode | ConfigErrorCode

/**
 * Generic CLI error carrying a structured code, optional hints, and a severity
 * type.
 *
 * `code` accepts either the consumer's `TCode` union or any code defined by
 * cli-core itself (`CliErrorCode`). Pass a string-literal union as `TCode` to
 * constrain codes per CLI; the cli-core codes are always allowed alongside.
 *
 * ```ts
 * import { CliError } from '@doist/cli-core'
 * type Code = 'AUTH_FAILED' | 'NOT_FOUND' | (string & {})
 * throw new CliError<Code>('AUTH_FAILED', 'Token rejected', {
 *     hints: ['Run td auth login'],
 * })
 * // CONFIG_INVALID_JSON also accepted without listing it in `Code`:
 * throw new CliError<Code>('CONFIG_INVALID_JSON', 'Bad JSON')
 * ```
 *
 * The `(string & {})` trick preserves intellisense while accepting dynamic codes.
 */
export class CliError<TCode extends string = string> extends Error {
    readonly code: TCode | CliErrorCode
    readonly hints?: string[]
    readonly type: ErrorType

    constructor(code: TCode | CliErrorCode, message: string, options: CliErrorOptions = {}) {
        super(message)
        this.name = 'CliError'
        this.code = code
        this.hints = options.hints
        this.type = options.type ?? 'error'
    }
}

/**
 * Extract a human-readable message from any thrown value. `Error` instances
 * keep their `.message`; everything else stringifies. Used at boundaries that
 * accept arbitrary values (catch blocks, fetch failures) so error formatting
 * stays consistent.
 */
export function getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
}
