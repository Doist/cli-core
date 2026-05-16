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
    id: string
    account: TAccount
    /**
     * Plaintext token, present only when the keyring was unavailable at write
     * time. cli-core prefers a keyring read over this field; consumers should
     * surface its presence as a security-relevant fact (it is the same
     * material that would otherwise live in the OS credential manager).
     */
    fallbackToken?: string
}

/**
 * Port the consumer implements to expose their per-user config records to
 * cli-core's keyring-backed `TokenStore`. The shape of the record map (file
 * format, path, schema versioning) stays in the consumer — cli-core only
 * needs CRUD on these primitives plus a default-user pointer.
 */
export type UserRecordStore<TAccount extends AuthAccount> = {
    list(): Promise<UserRecord<TAccount>[]>
    getById(id: string): Promise<UserRecord<TAccount> | null>
    upsert(record: UserRecord<TAccount>): Promise<void>
    remove(id: string): Promise<void>
    getDefaultId(): Promise<string | null>
    setDefaultId(id: string | null): Promise<void>
    /**
     * Human-readable location used in the fallback warning text (e.g.
     * `~/.config/todoist-cli/config.json`). Plain string; cli-core does not
     * interpret it.
     */
    describeLocation(): string
}
