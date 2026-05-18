import type { AuthAccount } from '../types.js'

/** Where a token was (or wasn't) persisted on the most recent write/clear. */
export type TokenStorageLocation = 'secure-store' | 'config-file'

export type TokenStorageResult = {
    storage: TokenStorageLocation
    /**
     * Present when the OS keyring was unavailable and the operation fell back
     * to (or left state in) the consumer's config file. Suitable for surfacing
     * to the user as a `Warning:` line on stderr.
     */
    warning?: string
}

export type UserRecord<TAccount extends AuthAccount> = {
    account: TAccount
    /**
     * Plaintext token, present only when the keyring was unavailable at write
     * time. The runtime reads it in preference to the keyring slot, so a
     * stale fallback would mask a fresh keyring-backed write — consumers
     * implementing `upsert` as replace-not-merge (per the contract below)
     * guarantees the field is cleared on every successful keyring write.
     * Surface its presence as security-relevant: it is the same material
     * that would otherwise live in the OS credential manager.
     */
    fallbackToken?: string
    /**
     * Plaintext refresh token, kept in step with `fallbackToken`: only ever
     * present when the keyring was unavailable at write time. Same
     * security-relevant treatment.
     */
    fallbackRefreshToken?: string
    /** Unix-epoch ms — when the persisted access token expires. */
    accessTokenExpiresAt?: number
    /** Unix-epoch ms — when the persisted refresh token expires (rarely known). */
    refreshTokenExpiresAt?: number
    /**
     * `true` iff a refresh token is known to exist in the sibling keyring
     * slot (or in `fallbackRefreshToken`). The keyring token store reads it
     * to decide whether to spend a second keyring round-trip on the refresh
     * slot during `active()`. A stale `true` (e.g. the refresh slot was
     * deleted out-of-band) downgrades to "no refresh available" via the
     * read path; a stale `false` would silently hide a refresh credential,
     * so writes must always update this bit atomically with the slot.
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
     * Optional atomic insert-if-absent. Returns `true` when the record was
     * persisted, `false` when a record with the same `account.id` already
     * existed (no write happened). Implementations that can guarantee
     * atomicity (single-process file lock, DB transaction, …) should
     * provide this so `migrateLegacyAuth` can avoid the TOCTOU race
     * between its existence check and the upsert. When omitted,
     * `migrateLegacyAuth` falls back to a list-then-upsert that has a
     * tiny race window — acceptable for postinstall-style invocations
     * but worth eliminating in production CLIs that run many concurrent
     * processes.
     */
    tryInsert?(record: UserRecord<TAccount>): Promise<boolean>
    /** Remove the record whose `account.id` matches. */
    remove(id: string): Promise<void>
    /** The pinned default's `account.id`, or `null` when nothing is pinned. */
    getDefaultId(): Promise<string | null>
    setDefaultId(id: string | null): Promise<void>
}
