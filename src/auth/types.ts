/** A single authenticated identity. `id` is the stable key the store indexes on. */
export type AuthAccount = {
    id: string
    label?: string
    [key: string]: unknown
}

export type PrepareInput = {
    redirectUri: string
    flags: Record<string, unknown>
}

export type PrepareResult = {
    handshake: Record<string, unknown>
}

export type AuthorizeInput = {
    redirectUri: string
    state: string
    scopes: string[]
    readOnly: boolean
    flags: Record<string, unknown>
    /** Carried over from `prepare()` if the provider implements it. */
    handshake: Record<string, unknown>
}

export type AuthorizeResult = {
    authorizeUrl: string
    /** Carried back into `exchangeCode` (PKCE verifier, etc.). */
    handshake: Record<string, unknown>
}

export type ExchangeInput = {
    code: string
    state: string
    redirectUri: string
    /**
     * Carries the `authorize`-time handshake plus the runtime-folded
     * `flags` and `readOnly` values that triggered the flow, so resolvers
     * registered on the provider have the same view they had during
     * `authorize`.
     */
    handshake: Record<string, unknown>
}

export type ExchangeResult<TAccount extends AuthAccount = AuthAccount> = {
    accessToken: string
    refreshToken?: string
    /** Unix-epoch ms when the access token expires. */
    expiresAt?: number
    /** Unix-epoch ms when the refresh token expires (rarely advertised by OAuth servers). */
    refreshTokenExpiresAt?: number
    /** Set when the token endpoint already identifies the account; skips `validateToken`. */
    account?: TAccount
}

/**
 * Persisted credential triple. `refreshToken` and `accessTokenExpiresAt`
 * are present only when the token endpoint returned them at login and the
 * provider implements `refreshToken`. Read by `refreshAccessToken` to
 * decide whether a proactive refresh is needed.
 */
export type TokenBundle = {
    accessToken: string
    refreshToken?: string
    /** Unix-epoch ms. */
    accessTokenExpiresAt?: number
    /** Unix-epoch ms. */
    refreshTokenExpiresAt?: number
}

export type ValidateInput = {
    token: string
    /** Same shape as `ExchangeInput.handshake` — carries the folded `flags` / `readOnly`. */
    handshake: Record<string, unknown>
}

export type RefreshInput<TAccount extends AuthAccount = AuthAccount> = {
    refreshToken: string
    /**
     * Synthesised at refresh time from the stored account — providers that
     * need a base URL or client_id at refresh should read it from here
     * (mirrors the `authorize`/`exchangeCode` handshake but without PKCE
     * state, which has long since been discarded).
     */
    handshake: Record<string, unknown>
    /** The account whose token is being refreshed. */
    account: TAccount
}

/**
 * Strategy interface every auth method implements. cli-core ships
 * `createPkceProvider` for the standard public-client PKCE flow; bespoke
 * methods (DCR, device code, magic-link, …) implement this directly.
 */
export type AuthProvider<TAccount extends AuthAccount = AuthAccount> = {
    /** Optional pre-flight (e.g. DCR). Runs before the callback server starts. */
    prepare?(input: PrepareInput): Promise<PrepareResult>
    authorize(input: AuthorizeInput): Promise<AuthorizeResult>
    exchangeCode(input: ExchangeInput): Promise<ExchangeResult<TAccount>>
    /** Skipped when `exchangeCode` already returned an `account`. */
    validateToken(input: ValidateInput): Promise<TAccount>
    /**
     * Optional. Exchange a refresh token for a fresh access token. Providers
     * whose servers don't issue refresh tokens (Twist, Todoist today) omit
     * this — `refreshAccessToken` will surface `AUTH_REFRESH_UNAVAILABLE`
     * when called against such a provider.
     */
    refreshToken?(input: RefreshInput<TAccount>): Promise<ExchangeResult<TAccount>>
}

/** Opaque account selector. Stores own the matching rule (id, email, label, …). */
export type AccountRef = string

/**
 * Persistent token + account storage. Uniformly multi-user-shaped — single-user
 * stores implement `list` / `setDefault` against their one stored account (see
 * the README example).
 */
export type TokenStore<TAccount extends AuthAccount = AuthAccount> = {
    /**
     * Active snapshot, or `null` when nothing matches (the attachers translate
     * a ref miss into `ACCOUNT_NOT_FOUND`). A store MAY throw
     * `CliError('AUTH_STORE_READ_FAILED', …)` when a matching record exists
     * but the token itself can't be read (e.g. an OS keyring backing the
     * store is offline) — `attachLogoutCommand` catches that code on the
     * explicit-ref path and proceeds with `clear(ref)`; `attachStatusCommand`
     * and `attachTokenViewCommand` propagate it.
     */
    /**
     * `bundle` is optional so consumers implementing their own `TokenStore`
     * against a backend that doesn't track refresh tokens or expiry can
     * keep returning just `{ token, account }`. cli-core's built-in
     * `createKeyringTokenStore` always supplies it, and helpers that need
     * the extras (`refreshAccessToken`, `status` rendering) fall back to a
     * synthesised `{ accessToken: token }` when it's absent.
     */
    active(
        ref?: AccountRef,
    ): Promise<{ token: string; bundle?: TokenBundle; account: TAccount } | null>
    /**
     * Persist `token` for `account`, replacing any previous entry. Throw
     * `CliError` for typed failures; other thrown values become
     * `AUTH_STORE_WRITE_FAILED`.
     */
    set(account: TAccount, token: string): Promise<void>
    /**
     * Persist a full credential bundle (access + optional refresh + expiry).
     * Optional: stores backed by simple single-token storage can omit this
     * and cli-core helpers will fall back to `set(account, bundle.accessToken)`,
     * which loses refresh + expiry metadata. The built-in
     * `createKeyringTokenStore` implements this so refresh-token flows work
     * end-to-end.
     *
     * `options.promoteDefault: true` lets explicit-login callers ask the
     * store to pin this account as the default when nothing is pinned yet
     * (mirrors `set`'s implicit promotion). Silent refresh paths omit it so
     * a refresh never mutates account selection.
     */
    setBundle?(
        account: TAccount,
        bundle: TokenBundle,
        options?: { promoteDefault?: boolean },
    ): Promise<void>
    /** Remove a stored credential. No-op when `ref` doesn't match. */
    clear(ref?: AccountRef): Promise<void>
    /** Every stored account with a default marker. */
    list(): Promise<ReadonlyArray<{ account: TAccount; isDefault: boolean }>>
    /** Mark `ref` as the new default. Throw `CliError('ACCOUNT_NOT_FOUND', …)` on miss. */
    setDefault(ref: AccountRef): Promise<void>
}
