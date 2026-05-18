import { CliError } from '../../errors.js'
import type { AccountRef, AuthAccount, TokenBundle, TokenStore } from '../types.js'
import { accountNotFoundError } from '../user-flag.js'
import { writeRecordWithKeyringFallback } from './record-write.js'
import {
    createSecureStore,
    DEFAULT_ACCOUNT_FOR_USER,
    SECURE_STORE_DESCRIPTION,
    SecureStoreUnavailableError,
    type SecureStore,
} from './secure-store.js'
import type { TokenStorageResult, UserRecord, UserRecordStore } from './types.js'

export type CreateKeyringTokenStoreOptions<TAccount extends AuthAccount> = {
    /** Application identifier used for every keyring entry (e.g. `'todoist-cli'`). */
    serviceName: string
    /** Consumer-owned per-user record store (typically backed by their config file). */
    userRecords: UserRecordStore<TAccount>
    /**
     * Human-readable location of the record store, used in the fallback-warning
     * text (e.g. `~/.config/todoist-cli/config.json`). Plain string; cli-core
     * does not interpret it.
     */
    recordsLocation: string
    /**
     * Builds the keyring `account` slug for a user id. Defaults to
     * `user-${id}`. Override only when migrating from a legacy naming scheme.
     */
    accountForUser?: (id: string) => string
    /**
     * Decides whether an account matches an `AccountRef` supplied via
     * `--user <ref>`. Defaults to id-or-label equality. Override to broaden
     * (e.g. case-insensitive email, alias map).
     */
    matchAccount?: (account: TAccount, ref: AccountRef) => boolean
}

export type KeyringTokenStore<TAccount extends AuthAccount> = TokenStore<TAccount> & {
    /** Storage result from the most recent `set()` call, or `undefined` before any (and reset to `undefined` when the most recent `set()` threw). */
    getLastStorageResult(): TokenStorageResult | undefined
    /** Storage result from the most recent `clear()` call, or `undefined` before any (and reset to `undefined` when the most recent `clear()` threw or was a no-op). */
    getLastClearResult(): TokenStorageResult | undefined
    /** Human-readable location of the underlying record store. Surfaced so `refreshAccessToken` can derive a sidecar lock path without re-plumbing options. */
    getRecordsLocation(): string
}

const DEFAULT_MATCH_ACCOUNT = <TAccount extends AuthAccount>(
    account: TAccount,
    ref: AccountRef,
): boolean => account.id === ref || account.label === ref

/** Sibling keyring slot for the refresh token. Kept here so every read/write site agrees on the wire format. */
export function refreshAccountSlot(accessSlot: string): string {
    return `${accessSlot}/refresh`
}

function toBundle(credentials: string | TokenBundle): TokenBundle {
    return typeof credentials === 'string' ? { accessToken: credentials } : credentials
}

/**
 * Multi-account `TokenStore` that keeps secrets in the OS credential manager
 * and per-user metadata in the consumer's `UserRecordStore`. Falls back to
 * plaintext tokens on the user record when the keyring is unreachable (WSL
 * without D-Bus, missing native binary, locked Keychain, …) so the CLI keeps
 * working at the cost of a visible warning.
 *
 * Read order in `active()` is `fallbackToken` first, then the keyring. That
 * matches the write semantics in `writeRecordWithKeyringFallback`: when the
 * keyring is online the record is written with no `fallbackToken`, so the
 * keyring read is the only path. When the keyring is offline the token is
 * parked on the record and must be reachable on every subsequent read.
 *
 * Refresh tokens live in a sibling keyring slot (`${account}/refresh`) so
 * that `clear()` can drop them without parsing the access slot's contents.
 *
 * Write order is keyring first, then `userRecords.upsert`. If the upsert
 * fails after a successful keyring write, both keyring entries are rolled
 * back via `deleteSecret()` to avoid orphan credentials for a user that
 * cli-core never managed to record.
 *
 * Clear order is the inverse: record removal first (the source of truth that
 * the rest of the CLI reads), then keyring delete (both slots). Any keyring
 * delete failure after a successful removal is downgraded to a warning — the
 * orphan secret is harmless because no record references it anymore, and
 * surfacing the error would corrupt local state (record gone, but caller
 * sees a thrown exception and assumes the clear failed).
 */
export function createKeyringTokenStore<TAccount extends AuthAccount>(
    options: CreateKeyringTokenStoreOptions<TAccount>,
): KeyringTokenStore<TAccount> {
    const { serviceName, userRecords, recordsLocation } = options
    const accountForUser = options.accountForUser ?? DEFAULT_ACCOUNT_FOR_USER
    const matchAccount = options.matchAccount ?? DEFAULT_MATCH_ACCOUNT

    let lastStorageResult: TokenStorageResult | undefined
    let lastClearResult: TokenStorageResult | undefined

    function accessStoreFor(account: TAccount): SecureStore {
        return createSecureStore({ serviceName, account: accountForUser(account.id) })
    }

    function refreshStoreFor(account: TAccount): SecureStore {
        return createSecureStore({
            serviceName,
            account: refreshAccountSlot(accountForUser(account.id)),
        })
    }

    type Snapshot = { records: UserRecord<TAccount>[]; defaultId: string | null }

    /**
     * Read both `list()` and `getDefaultId()` concurrently. Used by paths
     * that need the pinned default (no-ref `active`/`clear`, `list`, and
     * `clear`'s default-unpin check).
     */
    async function readFullSnapshot(): Promise<Snapshot> {
        const [records, defaultId] = await Promise.all([
            userRecords.list(),
            userRecords.getDefaultId(),
        ])
        return { records, defaultId }
    }

    function resolveTarget(
        snapshot: Snapshot,
        ref: AccountRef | undefined,
    ): UserRecord<TAccount> | null {
        if (ref !== undefined) {
            const matches = snapshot.records.filter((record) => matchAccount(record.account, ref))
            if (matches.length > 1) {
                throw new CliError(
                    'NO_ACCOUNT_SELECTED',
                    `Multiple stored accounts match "${ref}". Pass a more specific --user <ref> (e.g. a unique account id).`,
                )
            }
            return matches[0] ?? null
        }
        if (snapshot.defaultId) {
            const pinned = snapshot.records.find((r) => r.account.id === snapshot.defaultId)
            if (pinned) return pinned
        }
        if (snapshot.records.length === 1) return snapshot.records[0]
        if (snapshot.records.length === 0) return null
        throw new CliError(
            'NO_ACCOUNT_SELECTED',
            'Multiple accounts are stored but none is set as the default. Pass --user <ref>, or set a default in your CLI.',
        )
    }

    function fallbackResult(action: string): TokenStorageResult {
        return {
            storage: 'config-file',
            warning: `${SECURE_STORE_DESCRIPTION} unavailable; ${action} ${recordsLocation}`,
        }
    }

    /**
     * Read the access + refresh secrets for a record, preferring the
     * plaintext fallbacks when present (mirrors the contract that the
     * fallback is authoritative whenever it exists). Returns `null` for the
     * "stored corrupted state" case so callers can throw `AUTH_STORE_READ_FAILED`.
     */
    async function readBundleForRecord(record: UserRecord<TAccount>): Promise<TokenBundle | null> {
        const fallbackAccess = record.fallbackToken?.trim()
        if (fallbackAccess) {
            return {
                accessToken: fallbackAccess,
                refreshToken: record.fallbackRefreshToken?.trim() || undefined,
                accessTokenExpiresAt: record.accessTokenExpiresAt,
                refreshTokenExpiresAt: record.refreshTokenExpiresAt,
            }
        }

        let rawAccess: string | null
        try {
            rawAccess = await accessStoreFor(record.account).getSecret()
        } catch (error) {
            if (error instanceof SecureStoreUnavailableError) {
                throw new CliError(
                    'AUTH_STORE_READ_FAILED',
                    `${SECURE_STORE_DESCRIPTION} unavailable; could not read stored token (${error.message})`,
                )
            }
            throw error
        }

        const accessToken = rawAccess?.trim()
        if (!accessToken) return null

        // Refresh slot read errors are downgraded — a missing or unreadable
        // refresh token is not fatal (the access token alone is still usable
        // until it expires). Surface as "no refresh present" so the caller
        // sees a consistent shape.
        let rawRefresh: string | null = null
        try {
            rawRefresh = await refreshStoreFor(record.account).getSecret()
        } catch {
            rawRefresh = null
        }

        return {
            accessToken,
            refreshToken: rawRefresh?.trim() || undefined,
            accessTokenExpiresAt: record.accessTokenExpiresAt,
            refreshTokenExpiresAt: record.refreshTokenExpiresAt,
        }
    }

    return {
        async active(ref) {
            const snapshot: Snapshot =
                ref === undefined
                    ? await readFullSnapshot()
                    : { records: await userRecords.list(), defaultId: null }
            const record = resolveTarget(snapshot, ref)
            if (!record) return null

            const bundle = await readBundleForRecord(record)
            if (!bundle) {
                // Record exists, no `fallbackToken`, and the keyring slot is
                // empty — credential deleted out-of-band. Corrupted state,
                // not a miss.
                throw new CliError(
                    'AUTH_STORE_READ_FAILED',
                    `${SECURE_STORE_DESCRIPTION} returned no credential for the stored account; the keyring entry may have been removed externally.`,
                )
            }

            return { token: bundle.accessToken, bundle, account: record.account }
        },

        async set(account, credentials) {
            // Reset the cached storage result up front so a caller that
            // catches a thrown `set()` doesn't observe the previous call's
            // warning leaking through `getLastStorageResult`.
            lastStorageResult = undefined

            const bundle = toBundle(credentials)
            const { storedSecurely } = await writeRecordWithKeyringFallback({
                secureStore: accessStoreFor(account),
                refreshSecureStore: refreshStoreFor(account),
                userRecords,
                account,
                bundle,
            })

            // Best-effort default promotion — same rationale as before.
            try {
                const existingDefault = await userRecords.getDefaultId()
                if (!existingDefault) {
                    await userRecords.setDefaultId(account.id)
                }
            } catch {
                // best-effort
            }

            lastStorageResult = storedSecurely
                ? { storage: 'secure-store' }
                : fallbackResult('token saved as plaintext in')
        },

        async clear(ref) {
            lastClearResult = undefined

            const snapshot = await readFullSnapshot()
            const record = resolveTarget(snapshot, ref)
            if (!record) return

            await userRecords.remove(record.account.id)

            if (snapshot.defaultId === record.account.id) {
                try {
                    await userRecords.setDefaultId(null)
                } catch {
                    // best-effort
                }
            }

            const fallbackClear = fallbackResult('local auth state cleared in')

            // Always attempt to delete both keyring slots. Either may have
            // an orphan entry from a prior keyring-online write that was
            // later replaced by an offline-fallback write.
            let keyringClean = true
            try {
                await accessStoreFor(record.account).deleteSecret()
            } catch {
                keyringClean = false
            }
            try {
                await refreshStoreFor(record.account).deleteSecret()
            } catch {
                keyringClean = false
            }

            if (!keyringClean) {
                lastClearResult = fallbackClear
            } else {
                lastClearResult =
                    record.fallbackToken !== undefined ? fallbackClear : { storage: 'secure-store' }
            }
        },

        async list() {
            const snapshot = await readFullSnapshot()
            let implicitDefault: UserRecord<TAccount> | null = null
            try {
                implicitDefault = resolveTarget(snapshot, undefined)
            } catch {
                // multiple records, no default → `isDefault: false` for all
            }
            return snapshot.records.map((record) => ({
                account: record.account,
                isDefault: record.account.id === implicitDefault?.account.id,
            }))
        },

        async setDefault(ref) {
            const snapshot: Snapshot = { records: await userRecords.list(), defaultId: null }
            const record = resolveTarget(snapshot, ref)
            if (!record) {
                throw accountNotFoundError(ref)
            }
            await userRecords.setDefaultId(record.account.id)
        },

        getLastStorageResult() {
            return lastStorageResult
        },

        getLastClearResult() {
            return lastClearResult
        },

        getRecordsLocation() {
            return recordsLocation
        },
    }
}
