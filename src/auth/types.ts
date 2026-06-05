import type { ViewOptions } from '../options.js'

/** A single authenticated identity. `id` is the stable key the store indexes on. */
export type AuthAccount = {
    id: string
    label?: string
    [key: string]: unknown
}

/** The view + flags pair every auth attacher callback receives. */
export type AttachContextBase = {
    /** `--json` / `--ndjson` flag values, both present (defaulted to `false`). */
    view: Required<ViewOptions>
    /** Consumer-attached options. The standard registrar flags (`--json` / `--ndjson`, and `--user` where attached) are stripped. */
    flags: Record<string, unknown>
}

export type WithAccount<TAccount extends AuthAccount> = AttachContextBase & {
    account: TAccount
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
    /** Refresh-token expiry, unix-epoch ms. */
    refreshTokenExpiresAt?: number
    /**
     * The raw `scope` from the token response, when the server returned one
     * (RFC 6749 §5.1 — present especially when the granted scope differs from
     * what was requested). Lets a provider's `validateToken` record the
     * server-authoritative scope rather than re-deriving it from the request.
     */
    scope?: string
    /** Set when the token endpoint already identifies the account; skips `validateToken`. */
    account?: TAccount
}

export type ValidateInput = {
    token: string
    /** Same shape as `ExchangeInput.handshake` — carries the folded `flags` / `readOnly`. */
    handshake: Record<string, unknown>
}

export type RefreshInput = {
    refreshToken: string
    /** Same shape as `ExchangeInput.handshake` — empty when called outside `runOAuthFlow`. */
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
    /** Optional: exchange a refresh token for a fresh bundle. */
    refreshToken?(input: RefreshInput): Promise<ExchangeResult<TAccount>>
}

/** Write-side bundle for `setBundle`. Time fields are unix-epoch ms. */
export type TokenBundle = {
    accessToken: string
    refreshToken?: string
    accessTokenExpiresAt?: number
    refreshTokenExpiresAt?: number
}

/** Read-side snapshot returned by `activeBundle`. Mirrors `setBundle`'s write side. */
export type ActiveBundleSnapshot<TAccount extends AuthAccount = AuthAccount> = {
    account: TAccount
    bundle: TokenBundle
}

/** Opaque account selector. Stores own the matching rule (id, email, label, …). */
export type AccountRef = string

/**
 * Outcome of a successful `clear()`: the account that was removed plus whether
 * it was the effective default before removal. `clear()` returns `null` instead
 * when `ref` matched nothing.
 */
export type ClearedAccount<TAccount extends AuthAccount = AuthAccount> = {
    account: TAccount
    wasDefault: boolean
}

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
    active(ref?: AccountRef): Promise<{ token: string; account: TAccount } | null>
    /**
     * Token-free resolution of the active account (or the `ref` target) plus its
     * effective-default status, in a single metadata read — no token-slot IPC.
     * Optional: cli-core's `account current` falls back to `active()` + `list()`
     * when a store doesn't implement it. Returns `null` on no match.
     * `KeyringTokenStore` implements it so `current` doesn't pay a token read it
     * never uses.
     */
    activeAccount?(ref?: AccountRef): Promise<{ account: TAccount; isDefault: boolean } | null>
    /** Persist `token` for `account`, replacing any previous entry. Throw `CliError` for typed failures; other thrown values become `AUTH_STORE_WRITE_FAILED`. */
    set(account: TAccount, token: string): Promise<void>
    /**
     * Persist a full bundle. Optional on the contract — stores that don't
     * implement it get `bundle.accessToken` via `set()` instead (cli-core
     * helpers handle the fallback). Pass `promoteDefault: true` on first
     * login; omit on silent refresh so a background rotation can't re-pin
     * account selection.
     */
    setBundle?(
        account: TAccount,
        bundle: TokenBundle,
        options?: { promoteDefault?: boolean },
    ): Promise<void>
    /**
     * Full-bundle read for refresh-capable consumers. Returns the matching
     * account + bundle, or `null` on miss. Optional on the contract — the
     * silent-refresh helper throws `AUTH_REFRESH_UNAVAILABLE` when a custom
     * store doesn't implement it. `KeyringTokenStore` overrides this as
     * required so cli-core helpers can call it without a non-null assertion.
     *
     * Stores MAY throw `CliError('AUTH_STORE_READ_FAILED', …)` on the same
     * conditions as `active()` (e.g. keyring offline while a matching
     * record exists).
     */
    activeBundle?(ref?: AccountRef): Promise<ActiveBundleSnapshot<TAccount> | null>
    /**
     * Remove a stored credential **without reading the token** — a record whose
     * secret is unreadable (e.g. keyring offline) must still be removable.
     * Resolves + deletes in one step and returns the removed account plus
     * whether it was the effective default before removal, or `null` when `ref`
     * matched nothing (no-op). Throw `CliError` for typed failures.
     */
    clear(ref?: AccountRef): Promise<ClearedAccount<TAccount> | null>
    /** Every stored account with a default marker. */
    list(): Promise<ReadonlyArray<{ account: TAccount; isDefault: boolean }>>
    /** Mark `ref` as the new default. Throw `CliError('ACCOUNT_NOT_FOUND', …)` on miss. */
    setDefault(ref: AccountRef): Promise<void>
}
