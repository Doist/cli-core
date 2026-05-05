export type ErrorType = 'error' | 'info'

/**
 * Generic CLI error carrying a structured code, optional hints, and a severity type.
 *
 * Pass a string-literal union as `TCode` to constrain codes per CLI:
 *
 * ```ts
 * import { CliError } from '@doist/cli-core'
 * type Code = 'AUTH_FAILED' | 'NOT_FOUND' | (string & {})
 * throw new CliError<Code>('AUTH_FAILED', 'Token rejected')
 * ```
 *
 * The `(string & {})` trick preserves intellisense while accepting dynamic codes.
 */
export class CliError<TCode extends string = string> extends Error {
    constructor(
        public readonly code: TCode,
        message: string,
        public readonly hints?: string[],
        public readonly type: ErrorType = 'error',
    ) {
        super(message)
        this.name = 'CliError'
    }
}
