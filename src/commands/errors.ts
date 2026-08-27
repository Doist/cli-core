/**
 * Error codes thrown by shared command and output-option helpers. Folded into
 * the `CliErrorCode` aggregator in `../errors.ts` so consumers don't have to
 * redeclare them in their own `TCode` union when catching.
 */
export type CommandErrorCode =
    | 'CONFLICTING_OPTIONS'
    | 'INVALID_TYPE'
    | 'FILE_READ_ERROR'
    | 'INVALID_FLAGS'
    | 'INVALID_UPDATE_CHANNEL'
    | 'UPDATE_CHECK_FAILED'
    | 'UPDATE_INSTALL_FAILED'
