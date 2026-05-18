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
    | 'AUTH_STORE_READ_FAILED'
    /** Refresh token rejected — typically `invalid_grant`. Forces re-login. */
    | 'AUTH_REFRESH_EXPIRED'
    /** Refresh attempt failed transiently (network, 5xx, non-JSON). Caller may retry. */
    | 'AUTH_REFRESH_TRANSIENT'
    /** No refresh token stored, or provider doesn't implement `refreshToken`. */
    | 'AUTH_REFRESH_UNAVAILABLE'
    | 'NOT_AUTHENTICATED'
    | 'TOKEN_FROM_ENV'
    | 'NO_ACCOUNT_SELECTED'
    | 'ACCOUNT_NOT_FOUND'
