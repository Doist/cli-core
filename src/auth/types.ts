/**
 * Shape of a single authenticated identity. The `id` is the stable key the
 * `TokenStore` indexes on (e.g. an Outline user id, or just `'default'` when
 * no probe surfaces an external identity). Everything else is provider-
 * defined metadata the consumer may want to display or persist alongside the
 * token.
 */
export type AuthAccount = {
    id: string
    label?: string
    [key: string]: unknown
}

export type AuthBackend = 'config' | 'env'

/**
 * Optional pre-flight step a provider can run before the browser is opened.
 * The returned `handshake` is threaded through `authorize`, `exchangeCode`,
 * and `validateToken` so the provider can carry transient state without
 * relying on globals.
 *
 * Reserved for future flows (e.g. RFC 7591 Dynamic Client Registration). No
 * provider built into cli-core uses it today, but `runOAuthFlow` already
 * invokes it when present so a custom `AuthProvider` can opt in.
 */
export type PrepareInput = {
    /** Loopback redirect URI the callback server is bound to. */
    redirectUri: string
    /** Per-CLI flags collected at the command line, untyped on purpose. */
    flags: Record<string, unknown>
}

export type PrepareResult = {
    handshake: Record<string, unknown>
}

export type AuthorizeInput = {
    redirectUri: string
    /** Random state string the callback server will require back unchanged. */
    state: string
    /** Resolved scope list, after `--read-only` and `loginFlags` were applied. */
    scopes: string[]
    /** Was `--read-only` set? Providers can use this to swap scope bundles. */
    readOnly: boolean
    /** Per-CLI flags collected at the command line. */
    flags: Record<string, unknown>
    /** Carried over from `prepare()` if the provider implements it. */
    handshake: Record<string, unknown>
}

export type AuthorizeResult = {
    /** Fully-formed URL to open in the user's browser. */
    authorizeUrl: string
    /**
     * Anything the provider needs back when exchanging the code (PKCE
     * code_verifier, etc.). Returned verbatim to `exchangeCode`.
     */
    handshake: Record<string, unknown>
}

export type ExchangeInput = {
    code: string
    state: string
    redirectUri: string
    handshake: Record<string, unknown>
}

export type ExchangeResult<TAccount extends AuthAccount = AuthAccount> = {
    accessToken: string
    refreshToken?: string
    /** Unix-epoch milliseconds. Optional; cli-core does not refresh today. */
    expiresAt?: number
    /**
     * If the provider's token endpoint returns enough to identify the account
     * directly, set it here and `validateToken` will be skipped.
     */
    account?: TAccount
}

export type ValidateInput = {
    token: string
    /** Carried over from `prepare()` if relevant (e.g. base URL). */
    handshake: Record<string, unknown>
}

/**
 * The strategy interface every auth method implements. cli-core ships
 * `createPkceProvider` for the standard public-client PKCE flow; bespoke
 * methods (DCR, device code, etc.) implement this directly.
 */
export type AuthProvider<TAccount extends AuthAccount = AuthAccount> = {
    /** Optional pre-flight (e.g. DCR). Runs before the callback server starts. */
    prepare?(input: PrepareInput): Promise<PrepareResult>
    /** Build the URL the user is sent to in the browser. */
    authorize(input: AuthorizeInput): Promise<AuthorizeResult>
    /** Trade the callback's `code` for tokens. */
    exchangeCode(input: ExchangeInput): Promise<ExchangeResult<TAccount>>
    /**
     * Probe an authenticated endpoint to confirm the token works and resolve
     * the account record we'll persist. Skipped when `exchangeCode` already
     * returned an `account`.
     */
    validateToken(input: ValidateInput): Promise<TAccount>
}

/**
 * Persistent token + account storage. cli-core ships a single-user
 * config-backed implementation (`createConfigTokenStore`); consumers that
 * need OS-keychain backing or multi-account support implement their own.
 */
export type TokenStore<TAccount extends AuthAccount = AuthAccount> = {
    /** Resolve the active account for this CLI. */
    active(): Promise<{ token: string; account: TAccount } | null>
    /** Upsert the active account + token. */
    set(account: TAccount, token: string): Promise<void>
    /** Wipe the active account. */
    clear(): Promise<void>
    /** Where the active token came from on the most recent read. */
    backend(): Promise<AuthBackend>
}

/**
 * Per-CLI extra flag declared at registration time, threaded through to the
 * provider via `AuthorizeInput.flags`. The lookup key is derived from the
 * Commander long-flag the same way Commander itself derives option names —
 * `--additional-scopes` lands as `flags.additionalScopes`.
 */
export type LoginFlagSpec = {
    /** Commander flag spec, e.g. `'--additional-scopes <list>'`. */
    flags: string
    description: string
    /** Optional value parser. Defaults to identity (Commander's default behaviour). */
    parse?: (raw: string, previous: unknown) => unknown
    /** Default value when the flag isn't supplied. */
    defaultValue?: unknown
}

/**
 * Context passed into the `renderSuccess(ctx)` callback that produces the
 * post-authorization HTML the local server returns to the browser.
 */
export type SuccessContext = {
    /** Display name of the CLI (e.g. `'Outline'`). */
    displayName: string
    /** Identifier of the just-signed-in account, if available. */
    accountId?: string
    /** Friendly label of the just-signed-in account, if available. */
    accountLabel?: string
}

/**
 * Context passed into the `renderError(ctx)` callback that produces the HTML
 * shown when the OAuth callback failed (provider-side error, state mismatch,
 * timeout, …).
 */
export type ErrorContext = {
    displayName: string
    /** OAuth `error` parameter when the provider returned one. */
    errorCode?: string
    /** Human-readable explanation. Always set. */
    message: string
}
