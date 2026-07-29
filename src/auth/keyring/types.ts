import type { AuthAccount } from '../types.js'

/** Where a token was (or wasn't) persisted on the most recent write/clear. */
export type TokenStorageLocation = 'secure-store' | 'config-file'

/**
 * Policy for writing credentials through `createKeyringTokenStore`.
 *
 * `fallback` preserves the original behavior: prefer the system credential
 * manager and use the consumer's config record only when it is unavailable.
 */
export type CredentialStore = 'system' | 'plaintext' | 'fallback'

export type TokenStorageResult = {
    storage: TokenStorageLocation
    /**
     * Present when a write used (or a clear left state in) the consumer's
     * config file. Suitable for surfacing to the user as a `Warning:` line on
     * stderr.
     */
    warning?: string
}

export type UserRecord<TAccount extends AuthAccount> = {
    account: TAccount
    /**
     * Plaintext token, present when the keyring was unavailable under the
     * `'fallback'` policy or when the consumer explicitly selected
     * `'plaintext'`. The runtime reads it in preference to the keyring slot,
     * so a stale fallback would mask a fresh keyring-backed write — consumers
     * implementing `upsert` as replace-not-merge (per the contract below)
     * guarantee the field is cleared on every successful keyring write.
     * Surface its presence as security-relevant: it is the same material
     * that would otherwise live in the OS credential manager.
     */
    fallbackToken?: string
    /** Same lifecycle and security profile as `fallbackToken`, for the refresh slot. */
    fallbackRefreshToken?: string
    /** Access-token expiry, unix-epoch ms. */
    accessTokenExpiresAt?: number
    /** Refresh-token expiry, unix-epoch ms. */
    refreshTokenExpiresAt?: number
    /**
     * `true` when a refresh secret is stored (in the keyring or as
     * `fallbackRefreshToken`); `false` when explicitly cleared by `set()`
     * or by a no-refresh `setBundle`; `undefined` on legacy records that
     * predate the bundle contract. Read by future bundle-aware accessors;
     * `active()` itself doesn't consult it.
     */
    hasRefreshToken?: boolean
}

/**
 * Port the consumer implements to expose their per-user config records to
 * cli-core's keyring-backed `TokenStore`. The shape of the record map (file
 * format, path, schema versioning) stays in the consumer — cli-core only
 * needs CRUD on these primitives plus a default-user pointer.
 */
export type UserRecordStore<TAccount extends AuthAccount> = {
    list(): Promise<UserRecord<TAccount>[]>
    /**
     * **Replace**, do not merge. The persisted record must equal `record` field
     * for field — an absent `fallbackToken` means "no plaintext token", and a
     * merge-style implementation would let a stale plaintext token outlive a
     * later keyring-backed write (the runtime preferentially reads
     * `fallbackToken` over the keyring). Records are keyed by `account.id`.
     */
    upsert(record: UserRecord<TAccount>): Promise<void>
    /**
     * Optional atomic insert. Returns `true` on write, `false` if `account.id`
     * already exists. Migration prefers it to eliminate the existence-check
     * TOCTOU race; callers fall back to list-then-upsert when absent.
     */
    tryInsert?(record: UserRecord<TAccount>): Promise<boolean>
    /** Remove the record whose `account.id` matches. */
    remove(id: string): Promise<void>
    /** The pinned default's `account.id`, or `null` when nothing is pinned. */
    getDefaultId(): Promise<string | null>
    setDefaultId(id: string | null): Promise<void>
}
