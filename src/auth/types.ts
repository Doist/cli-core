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
    /** Access-token expiry, unix-epoch ms. */
    expiresAt?: number
    /**
     * Refresh-token expiry, unix-epoch ms. Most servers don't return one;
     * the refresh helper carries the previous value forward when set.
     */
    refreshTokenExpiresAt?: number
    /** Set when the token endpoint already identifies the account; skips `validateToken`. */
    account?: TAccount
}

export type ValidateInput = {
    token: string
    /** Same shape as `ExchangeInput.handshake` — carries the folded `flags` / `readOnly`. */
    handshake: Record<string, unknown>
}

/**
 * Input to `AuthProvider.refreshToken`. Symmetric with `ExchangeInput` so
 * providers can share helpers; `handshake` is empty unless a future
 * orchestrator threads state through.
 */
export type RefreshInput = {
    refreshToken: string
    handshake: Record<string, unknown>
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
     * Optional: exchange a refresh token for a fresh bundle. Implemented by
     * providers that target servers issuing refresh tokens (e.g. Outline).
     * `refreshAccessToken` throws `AUTH_REFRESH_UNAVAILABLE` when this is
     * absent or when the stored bundle carries no refresh token.
     */
    refreshToken?(input: RefreshInput): Promise<ExchangeResult<TAccount>>
}

/**
 * The shape `KeyringTokenStore` persists per account. Custom `TokenStore`
 * implementations that opt into refresh-token support return this from
 * `active()` and accept it on `setBundle`. All time fields are unix-epoch ms.
 */
export type TokenBundle = {
    accessToken: string
    refreshToken?: string
    accessTokenExpiresAt?: number
    refreshTokenExpiresAt?: number
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
    active(
        ref?: AccountRef,
    ): Promise<{ token: string; account: TAccount; bundle?: TokenBundle } | null>
    /** Persist `token` for `account`, replacing any previous entry. Throw `CliError` for typed failures; other thrown values become `AUTH_STORE_WRITE_FAILED`. */
    set(account: TAccount, token: string): Promise<void>
    /**
     * Persist a full bundle (access + optional refresh + optional expiries).
     * Optional on the contract — custom consumer stores that never carry
     * refresh tokens can leave this unimplemented and cli-core helpers fall
     * back to `set(account, bundle.accessToken)`. `KeyringTokenStore`
     * implements it as a required override.
     *
     * `promoteDefault` is true on first-login persistence (initial account
     * gets pinned as default) and omitted on silent refresh paths so a
     * background rotation can't mutate account selection.
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
