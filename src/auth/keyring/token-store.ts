import { CliError } from '../../errors.js'
import type { AccountRef, AuthAccount, TokenBundle, TokenStore } from '../types.js'
import { accountNotFoundError } from '../user-flag.js'
import { findById } from './internal.js'
import { writeRecordWithKeyringFallback } from './record-write.js'
import {
    createSecureStore,
    DEFAULT_ACCOUNT_FOR_USER,
    SECURE_STORE_DESCRIPTION,
    SecureStoreUnavailableError,
    type SecureStore,
} from './secure-store.js'
import { refreshAccountSlot } from './slot-naming.js'
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
    /**
     * Override `TokenStore.setBundle?` as required — `createKeyringTokenStore`
     * always provides it. Lets callers (and tests) drop the `store.setBundle!`
     * non-null assertion when they know they're working with this concrete
     * store.
     */
    setBundle: NonNullable<TokenStore<TAccount>['setBundle']>
    /** Storage result from the most recent `set()` / `setBundle()` call, or `undefined` before any (and reset to `undefined` when the most recent call threw). */
    getLastStorageResult(): TokenStorageResult | undefined
    /** Storage result from the most recent `clear()` call, or `undefined` before any (and reset to `undefined` when the most recent `clear()` threw or was a no-op). */
    getLastClearResult(): TokenStorageResult | undefined
}

const DEFAULT_MATCH_ACCOUNT = <TAccount extends AuthAccount>(
    account: TAccount,
    ref: AccountRef,
): boolean => account.id === ref || account.label === ref

/**
 * Multi-account `TokenStore` that keeps secrets in the OS credential manager
 * and per-user metadata in the consumer's `UserRecordStore`. Falls back to
 * plaintext tokens on the user record when the keyring is unreachable.
 *
 * Refresh tokens live in a sibling keyring slot (`${account}/refresh`) so
 * `clear()` can drop them without parsing the access slot's contents. Reads
 * are gated on `UserRecord.hasRefreshToken` so accounts without refresh
 * tokens don't pay a second keyring round-trip per `active()` call.
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
     * plaintext fallbacks when present. Throws `AUTH_STORE_READ_FAILED`
     * directly when the access slot is empty (deleted out-of-band) or
     * when the keyring read itself fails — collapsing it to a return
     * value here would leave the caller doing the same `if (!bundle)
     * throw` dance, smearing the corruption signal across two places.
     * `attachLogoutCommand` catches this code specifically so an explicit
     * `logout --user <ref>` can still clear the corrupted record.
     */
    async function readBundleForRecord(record: UserRecord<TAccount>): Promise<TokenBundle> {
        const fallbackAccess = record.fallbackToken?.trim()
        if (fallbackAccess) {
            return {
                accessToken: fallbackAccess,
                refreshToken: record.fallbackRefreshToken?.trim() || undefined,
                accessTokenExpiresAt: record.accessTokenExpiresAt,
                refreshTokenExpiresAt: record.refreshTokenExpiresAt,
            }
        }

        // Parallel reads: access slot always needed; refresh slot only when
        // the record says it exists. Sequential reads here would double the
        // IPC latency on every authenticated command. The refresh read is
        // wrapped in `.catch(() => null)` so a transient keyring hiccup on
        // the (non-essential) refresh slot doesn't fail an otherwise-valid
        // access-token lookup.
        const accessPromise = accessStoreFor(record.account)
            .getSecret()
            .catch((error: unknown) => {
                if (error instanceof SecureStoreUnavailableError) {
                    throw new CliError(
                        'AUTH_STORE_READ_FAILED',
                        `${SECURE_STORE_DESCRIPTION} unavailable; could not read stored token (${error.message})`,
                    )
                }
                throw error
            })
        // `!== false` rather than truthy: a record with `hasRefreshToken:
        // undefined` (e.g. one written by the legacy-migration path which
        // has no authority over refresh state) means "unknown — try the
        // slot". Treating undefined as "no" here would silently hide a v2
        // refresh secret that a later v2 login put in the sibling slot.
        //
        // Refresh-slot read failures are tolerated **only** for the
        // documented keyring-offline case (`SecureStoreUnavailableError`).
        // Anything else (programming error, unexpected backend) propagates
        // so it can't silently downgrade a real bug into "no refresh
        // token". The access-token path runs in parallel and its own
        // catch maps a keyring-offline failure to `AUTH_STORE_READ_FAILED`.
        const refreshPromise =
            record.hasRefreshToken !== false
                ? refreshStoreFor(record.account)
                      .getSecret()
                      .catch((error: unknown) => {
                          if (error instanceof SecureStoreUnavailableError) return null
                          throw error
                      })
                : Promise.resolve(null)

        const [rawAccess, rawRefresh] = await Promise.all([accessPromise, refreshPromise])

        const accessToken = rawAccess?.trim()
        if (!accessToken) {
            // Record exists, no `fallbackToken`, and the keyring slot is
            // empty — the credential was deleted out-of-band (user ran
            // `security delete-generic-password`, `secret-tool clear`, …).
            throw new CliError(
                'AUTH_STORE_READ_FAILED',
                `${SECURE_STORE_DESCRIPTION} returned no credential for the stored account; the keyring entry may have been removed externally.`,
            )
        }

        const refreshToken = rawRefresh?.trim() || undefined

        // Backfill `hasRefreshToken` best-effort when we probed the refresh
        // slot (record said `undefined` — "unknown") and now know whether
        // a secret is there. Pre-PR records didn't carry this bit; without
        // the backfill they'd pay an extra keyring IPC per `active()`
        // call forever (when the slot is empty) or get the right answer
        // by luck of probing it every time (when populated).
        //
        // The upsert is `replace, not merge` per the contract, so spreading
        // `record` (a stale snapshot from the earlier `list()`) would risk
        // overwriting a concurrent `setBundle`'s richer record. Re-read
        // inside the backfill helper, then compare the freshly-read shape
        // against the snapshot we made the read decision on: only flip the
        // bit when the record is STILL the "undefined" placeholder we
        // just probed. Anything else (a v2 login landed, the user logged
        // out, …) means our state is stale and we leave it alone.
        if (record.hasRefreshToken === undefined) {
            void backfillHasRefreshToken(record, refreshToken !== undefined).catch(() => undefined)
        }

        return {
            accessToken,
            refreshToken,
            accessTokenExpiresAt: record.accessTokenExpiresAt,
            refreshTokenExpiresAt: record.refreshTokenExpiresAt,
        }
    }

    /** Snapshot for a ref-only resolve path; skips the `getDefaultId` read. */
    function refOnlySnapshot(records: UserRecord<TAccount>[]): Snapshot {
        return { records, defaultId: null }
    }

    /**
     * Re-read the record before backfilling `hasRefreshToken` so the
     * upsert can't clobber a concurrent `setBundle`'s richer state
     * (`UserRecordStore.upsert` is replace-not-merge per the contract).
     * Only writes when the record still matches the placeholder shape
     * we made the backfill decision on — same fields, same `undefined`
     * `hasRefreshToken`, same fallbacks. Any divergence means a
     * concurrent write landed between our `list()` read and now, and
     * the right thing is to leave the fresh state alone.
     */
    async function backfillHasRefreshToken(
        staleRecord: UserRecord<TAccount>,
        present: boolean,
    ): Promise<void> {
        const fresh = findById(await userRecords.list(), staleRecord.account.id)
        if (!fresh) return
        if (
            fresh.hasRefreshToken !== undefined ||
            fresh.fallbackToken !== staleRecord.fallbackToken ||
            fresh.fallbackRefreshToken !== staleRecord.fallbackRefreshToken ||
            fresh.accessTokenExpiresAt !== staleRecord.accessTokenExpiresAt ||
            fresh.refreshTokenExpiresAt !== staleRecord.refreshTokenExpiresAt
        ) {
            return
        }
        await userRecords.upsert({ ...fresh, hasRefreshToken: present })
    }

    /**
     * Shared persistence path for `set` / `setBundle`. The `promoteDefault`
     * flag is `true` for explicit-login callers (the legacy `set(token)`
     * path always promotes; the `setBundle(account, bundle, {
     * promoteDefault: true })` path opts in via the option). Silent refresh
     * never promotes — credential rotation must not mutate account
     * selection. Renamed away from the shared module's `persistBundle` so
     * navigation isn't ambiguous.
     */
    async function writeBundle(
        account: TAccount,
        bundle: TokenBundle,
        promoteDefault: boolean,
    ): Promise<void> {
        lastStorageResult = undefined

        const { storedSecurely } = await writeRecordWithKeyringFallback({
            secureStore: accessStoreFor(account),
            refreshSecureStore: refreshStoreFor(account),
            userRecords,
            account,
            bundle,
        })

        if (promoteDefault) {
            // Best-effort: a failure here must not turn into
            // `AUTH_STORE_WRITE_FAILED` (the user can recover by setting a
            // default later).
            try {
                const existingDefault = await userRecords.getDefaultId()
                if (!existingDefault) {
                    await userRecords.setDefaultId(account.id)
                }
            } catch {
                // best-effort
            }
        }

        lastStorageResult = storedSecurely
            ? { storage: 'secure-store' }
            : fallbackResult('token saved as plaintext in')
    }

    return {
        async active(ref) {
            const snapshot =
                ref === undefined
                    ? await readFullSnapshot()
                    : refOnlySnapshot(await userRecords.list())
            const record = resolveTarget(snapshot, ref)
            if (!record) return null

            const bundle = await readBundleForRecord(record)
            return { token: bundle.accessToken, bundle, account: record.account }
        },

        async set(account, token) {
            await writeBundle(account, { accessToken: token }, true)
        },

        async setBundle(account, bundle, setOptions) {
            // Default promotion is opt-in here: callers from the explicit
            // login path pass `promoteDefault: true`; silent refresh omits
            // it so credential rotation doesn't mutate account selection.
            await writeBundle(account, bundle, setOptions?.promoteDefault === true)
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
            // later replaced by an offline-fallback write. Run them
            // concurrently — they're independent and the keyring IPC
            // round-trip is the latency-heavy part.
            const [accessResult, refreshResult] = await Promise.allSettled([
                accessStoreFor(record.account).deleteSecret(),
                refreshStoreFor(record.account).deleteSecret(),
            ])
            const keyringClean =
                accessResult.status === 'fulfilled' && refreshResult.status === 'fulfilled'

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
            const snapshot = refOnlySnapshot(await userRecords.list())
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
    }
}
