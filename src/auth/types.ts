/**
 * Shape of a single authenticated identity. The `id` is the stable key the
 * `TokenStore` indexes on (e.g. a Todoist user id, a Twist user id, or just
 * `'default'` for single-user CLIs). Everything else is provider-defined
 * metadata the CLI surfaces in `status` output and may persist alongside the
 * token (workspace ids, scope strings, display name, …).
 */
export type AuthAccount = {
    id: string
    label?: string
    [key: string]: unknown
}

export type AuthBackend = 'keyring' | 'config' | 'env'

export type TokenStoreSetOptions = {
    /** Mark this account as active in the same write. */
    setActive?: boolean
}

/**
 * Result of an optional pre-flight step the provider can run before the
 * browser is opened — e.g. Twist's Dynamic Client Registration POST. The
 * returned `handshake` is threaded through `authorize` and `exchangeCode` so
 * the provider can carry transient state (a freshly-issued client_secret, a
 * client_id picked by the user, …) without globals.
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
     * code_verifier, DCR client_secret, …). Returned verbatim to
     * `exchangeCode`.
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

export type PasteInput = {
    /** The literal token the user pasted in via `--token`. */
    token: string
    /** Per-CLI flags collected at the command line. */
    flags: Record<string, unknown>
}

/**
 * The strategy interface every auth method implements. Built-in factories
 * (`createPkceProvider`, `createDcrProvider`, `createTokenPasteProvider`)
 * cover the three current CLIs; bespoke flows (device code, magic link,
 * username/password, …) implement this directly.
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
    /**
     * Optional manual-paste path. When present, `<cli> auth login --token
     * <value>` short-circuits the OAuth flow and calls this directly.
     */
    acceptPastedToken?(input: PasteInput): Promise<TAccount>
}

/**
 * Persistent token + account storage. Multi-user backends list every
 * authenticated identity; single-user backends always return at most one.
 *
 * The shape is intentionally agnostic about *where* tokens live (config file,
 * OS keychain, …) — `createConfigTokenStore` and `createKeyringTokenStore`
 * are concrete implementations.
 */
export type TokenStore<TAccount extends AuthAccount = AuthAccount> = {
    /** All known accounts. Empty array on a clean install. */
    list(): Promise<TAccount[]>
    /** Look up by `account.id`. Returns null when unknown or the token is unrecoverable. */
    get(id: string): Promise<{ token: string; account: TAccount } | null>
    /** Resolve "the account this CLI should use right now". */
    active(): Promise<{ token: string; account: TAccount } | null>
    /**
     * Upsert. Implementations are expected to overwrite an existing record at
     * `account.id`. Pass `{ setActive: true }` to atomically mark this account
     * as active in the same store mutation — multi-user backends collapse the
     * write into one cycle instead of two.
     */
    set(account: TAccount, token: string, options?: TokenStoreSetOptions): Promise<void>
    /** Mark `id` as the default account returned by `active()`. */
    setActive(id: string): Promise<void>
    /** Remove a single account. */
    delete(id: string): Promise<void>
    /** Wipe every account. Used by `<cli> auth logout` when no `--user` is given. */
    clear(): Promise<void>
    /** Where the active token came from on the most recent read. */
    backend(): Promise<AuthBackend>
}

/**
 * Hook a CLI passes to `createConfigTokenStore` so it can detect a legacy
 * pre-multi-user config shape on first read and migrate it forward. Returning
 * `null` means "nothing to migrate"; returning a `{ accounts, activeId }`
 * structure causes the store to write the v2 shape and serve from it.
 *
 * The migration body is CLI-specific (it usually probes the API to identify
 * the legacy token's owner) so cli-core stays provider-agnostic.
 */
export type StoreMigration<TAccount extends AuthAccount = AuthAccount> = (
    rawConfig: Record<string, unknown>,
) => Promise<{ accounts: TAccount[]; activeId?: string } | null>

/**
 * Per-CLI extra flag declared at registration time, threaded through to the
 * provider via `AuthorizeInput.flags`. The lookup key is derived from the
 * Commander long-flag the same way Commander itself derives option names —
 * `--additional-scopes` lands as `flags.additionalScopes`.
 *
 * Example — Todoist's `--additional-scopes`:
 *
 * ```ts
 * { flags: '--additional-scopes <list>',
 *   description: 'Comma-separated extra scopes to request',
 *   parse: (raw) => raw.split(',').map((s) => s.trim()) }
 * ```
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
    /** Display name of the CLI (e.g. `'Todoist'`). */
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
