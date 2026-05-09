/**
 * Error codes thrown by `@doist/cli-core/commands` registration helpers. Folded
 * into the `CliErrorCode` aggregator in `../errors.ts` so consumers don't have
 * to redeclare them in their own `TCode` union when catching.
 */
export type CommandErrorCode =
    | 'INVALID_TYPE'
    | 'FILE_READ_ERROR'
    | 'INVALID_FLAGS'
    | 'INVALID_UPDATE_CHANNEL'
    | 'UPDATE_CHECK_FAILED'
    | 'UPDATE_INSTALL_FAILED'
