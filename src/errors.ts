export type ErrorType = 'error' | 'info'

export interface CliErrorOptions {
    hints?: string[]
    type?: ErrorType
}

/**
 * Generic CLI error carrying a structured code, optional hints, and a severity type.
 *
 * Pass a string-literal union as `TCode` to constrain codes per CLI:
 *
 * ```ts
 * import { CliError } from '@doist/cli-core'
 * type Code = 'AUTH_FAILED' | 'NOT_FOUND' | (string & {})
 * throw new CliError<Code>('AUTH_FAILED', 'Token rejected', {
 *     hints: ['Run td auth login'],
 * })
 * ```
 *
 * The `(string & {})` trick preserves intellisense while accepting dynamic codes.
 */
export class CliError<TCode extends string = string> extends Error {
    readonly hints?: string[]
    readonly type: ErrorType

    constructor(
        public readonly code: TCode,
        message: string,
        options: CliErrorOptions = {},
    ) {
        super(message)
        this.name = 'CliError'
        this.hints = options.hints
        this.type = options.type ?? 'error'
    }
}
