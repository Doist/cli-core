/**
 * Error codes thrown by `@doist/cli-core/auth`. Folded into the `CliErrorCode`
 * aggregator in `../errors.ts` so consumers don't have to redeclare them in
 * their own `TCode` union when catching.
 */
export type AuthErrorCode =
    | 'AUTH_OAUTH_FAILED'
    | 'AUTH_CALLBACK_TIMEOUT'
    | 'AUTH_PORT_BIND_FAILED'
    | 'AUTH_TOKEN_EXCHANGE_FAILED'
    | 'AUTH_STORE_WRITE_FAILED'
