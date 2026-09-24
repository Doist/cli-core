/**
 * Every code the extension system throws through `CliError`. Folded into
 * `CliErrorCode`, so a host never has to list them in its own union.
 */
export type ExtensionErrorCode =
    | 'EXTENSION_ALREADY_EXISTS'
    | 'EXTENSION_ALREADY_INSTALLED'
    | 'EXTENSION_CHECKSUM_MISMATCH'
    | 'EXTENSION_DIRTY'
    | 'EXTENSION_INSTALL_FAILED'
    | 'EXTENSION_NAME_INVALID'
    | 'EXTENSION_NAME_RESERVED'
    | 'EXTENSION_NEEDS_SHELL'
    | 'EXTENSION_NOT_EXECUTABLE'
    | 'EXTENSION_NOT_FOUND'
    | 'EXTENSION_NOT_INSTALLABLE'
    | 'EXTENSION_NPM_MISSING'
    | 'EXTENSION_TEMPLATE_INVALID'
