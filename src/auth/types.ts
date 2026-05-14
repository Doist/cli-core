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
    /** Unix-epoch ms. cli-core does not refresh today. */
    expiresAt?: number
    /** Set when the token endpoint already identifies the account; skips `validateToken`. */
    account?: TAccount
}

export type ValidateInput = {
    token: string
    /** Same shape as `ExchangeInput.handshake` — carries the folded `flags` / `readOnly`. */
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
}

/**
 * Opaque selector for picking a specific account out of a multi-user store.
 * cli-core does not constrain the matching semantics — a store may match on
 * id, email, label, or anything else it persists. Single-user stores ignore
 * `ref` entirely.
 */
export type AccountRef = string

/**
 * Persistent token + account storage. Consumers implement this against
 * whatever storage they need (config file, OS keychain, multi-account…).
 * cli-core does not ship a default implementation; the interface is small
 * enough that an inline implementation covers both the single-user and the
 * multi-user case.
 *
 * The contract is uniformly multi-user-shaped — single-user consumers
 * implement the enumeration methods trivially against their one stored
 * account (see the README example). The `--user <ref>` flag is always
 * attached by `attachLogoutCommand` / `attachStatusCommand` /
 * `attachTokenViewCommand`; single-user stores either match it against the
 * one account or throw `CliError('ACCOUNT_NOT_FOUND', …)`.
 */
export type TokenStore<TAccount extends AuthAccount = AuthAccount> = {
    /**
     * The currently signed-in identity, or `null` when nothing is stored.
     * With `ref`, returns that specific account's snapshot; without, returns
     * the default/only account. A `ref` that does not match any stored
     * account returns `null` (consumers translate the miss into a typed error
     * via their own resolver).
     */
    active(ref?: AccountRef): Promise<{ token: string; account: TAccount } | null>
    /** Persist `token` for `account`, replacing any previous entry. Throw `CliError` to surface a typed failure; any other thrown value is wrapped as `AUTH_STORE_WRITE_FAILED`. */
    set(account: TAccount, token: string): Promise<void>
    /**
     * Remove a stored credential. With `ref`, removes that specific account;
     * without, removes the default/only account. No-op when nothing matches.
     */
    clear(ref?: AccountRef): Promise<void>
    /**
     * Enumerate every stored account with a default marker. Single-user
     * stores return a one-element array (or empty when nothing is stored).
     */
    list(): Promise<ReadonlyArray<{ account: TAccount; isDefault: boolean }>>
    /**
     * Mark `ref` as the new default account. Single-user stores either
     * match `ref` against the one stored account or throw
     * `CliError('ACCOUNT_NOT_FOUND', …)`.
     */
    setDefault(ref: AccountRef): Promise<void>
}
