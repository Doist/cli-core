import { getErrorMessage } from '../../errors.js'
import type { AuthAccount } from '../types.js'
import { findById, trySetSecret } from './internal.js'
import { writeRecordWithKeyringFallback } from './record-write.js'
import {
    createSecureStore,
    DEFAULT_ACCOUNT_FOR_USER,
    type SecureStore,
    SecureStoreUnavailableError,
} from './secure-store.js'
import { refreshAccountSlot } from './slot-naming.js'
import type { UserRecordStore } from './types.js'

export type MigrateLegacyAuthOptions<TAccount extends AuthAccount> = {
    serviceName: string
    /** Legacy single-user keyring account slug, e.g. `'api-token'`. */
    legacyAccount: string
    /** v2 user-record store the migrated record is written into. */
    userRecords: UserRecordStore<TAccount>
    /** Per-user keyring slug for the new entry. Defaults to `user-${id}`. */
    accountForUser?: (id: string) => string
    /**
     * Reads the durable "migration already ran" marker the consumer owns
     * (typically a flag in their config). When this returns `true`, the
     * helper short-circuits with `already-migrated` and never touches the
     * legacy state. This is the **one-way gate** — without it, a later
     * `logout` (which empties `userRecords`) followed by a reinstall would
     * cause the helper to re-migrate a stale legacy token.
     */
    hasMigrated: () => Promise<boolean>
    /**
     * Persists the durable migration marker. Called **after** the v2 record
     * write succeeds and **before** legacy cleanup so the gate is set before
     * any best-effort follow-up runs. If this throws, the helper returns a
     * `skipped` result with reason `marker-write-failed` — the v2 record is
     * already on disk, but the marker isn't, so the caller should retry.
     */
    markMigrated: () => Promise<void>
    /**
     * Returns the v1 token from the consumer's *plaintext* config slot, or
     * `null` if absent. cli-core handles the legacy keyring slot itself.
     */
    loadLegacyPlaintextToken: () => Promise<string | null>
    /**
     * Identifies the user behind the v1 token. Implementations typically hit
     * the product API with the token to fetch the canonical `id` / `email`
     * for the new account record.
     */
    identifyAccount: (token: string) => Promise<TAccount>
    /**
     * Optional best-effort cleanup of v1-only config fields after a
     * successful migration (e.g. unset legacy `api_token` / `auth_mode`).
     * Runs concurrently with the legacy keyring delete; failures are
     * swallowed because the marker (above) is what gates re-migration.
     */
    cleanupLegacyConfig?: () => Promise<void>
    /** Suppress stderr output (postinstall hooks set this). */
    silent?: boolean
    /** Label used in the stderr log line. Defaults to `'cli'`. */
    logPrefix?: string
}

/**
 * Stable skip reasons. `legacy-keyring-unreachable` is retryable (a later
 * run with the keyring online would succeed); the others are diagnostic.
 */
export type MigrateSkipReason =
    | 'identify-failed'
    | 'legacy-keyring-unreachable'
    | 'user-record-write-failed'
    | 'marker-write-failed'

const SKIP_REASON_MESSAGES: Record<MigrateSkipReason, string> = {
    'identify-failed': 'could not identify user',
    'legacy-keyring-unreachable': 'legacy credential is unreachable (keyring offline)',
    'user-record-write-failed': 'failed to update user records',
    'marker-write-failed': 'failed to persist migration marker',
}

/**
 * Discriminated by `status`. Narrowing on `status === 'skipped'` exposes
 * the structured `reason` + free-form `detail`; `migrated` carries the
 * resolved account.
 */
export type MigrateAuthResult<TAccount extends AuthAccount = AuthAccount> =
    | { status: 'already-migrated' }
    | { status: 'no-legacy-state' }
    | { status: 'migrated'; account: TAccount }
    | { status: 'skipped'; reason: MigrateSkipReason; detail: string }

type LegacyTokenResult =
    | { kind: 'found'; token: string }
    | { kind: 'none' }
    | { kind: 'keyring-unavailable' }

/**
 * One-time migration of a v1 single-user auth state into a v2 multi-user
 * shape. Best-effort: any failure (offline keyring, network error fetching
 * the user, …) leaves the v1 state untouched so the consumer's runtime
 * fallback can keep serving the legacy token until the next attempt.
 *
 * Order of operations is deliberate so the migration is genuinely one-way:
 *
 *   1. `hasMigrated()` short-circuits if the durable marker is already set.
 *   2. Read the v1 token (legacy keyring slot first, then plaintext).
 *   3. `identifyAccount(token)` resolves the v2 `account` shape.
 *   4. `writeRecordWithKeyringFallback` writes the v2 record.
 *   5. Best-effort `setDefaultId(account.id)` so the new record is active.
 *   6. `markMigrated()` persists the marker. **If this fails, we return
 *      `skipped` even though the v2 record is on disk** — the marker is
 *      what prevents re-migration on the next run.
 *   7. Best-effort legacy keyring delete + `cleanupLegacyConfig()` run
 *      concurrently. Failures here are harmless because the marker is set.
 */
export async function migrateLegacyAuth<TAccount extends AuthAccount>(
    options: MigrateLegacyAuthOptions<TAccount>,
): Promise<MigrateAuthResult<TAccount>> {
    const {
        serviceName,
        legacyAccount,
        userRecords,
        hasMigrated,
        markMigrated,
        loadLegacyPlaintextToken,
        identifyAccount,
        cleanupLegacyConfig,
        silent,
    } = options
    const accountForUser = options.accountForUser ?? DEFAULT_ACCOUNT_FOR_USER
    const logPrefix = options.logPrefix ?? 'cli'

    if (await hasMigrated()) {
        return { status: 'already-migrated' }
    }

    // One legacy-keyring handle covers both the initial read and the
    // post-success cleanup delete.
    const legacyStore = createSecureStore({ serviceName, account: legacyAccount })

    const legacyToken = await readLegacyToken(legacyStore, loadLegacyPlaintextToken)
    if (legacyToken.kind === 'none') return { status: 'no-legacy-state' }
    if (legacyToken.kind === 'keyring-unavailable') {
        return skipped(
            silent,
            logPrefix,
            'legacy-keyring-unreachable',
            'OS keyring unreachable while reading legacy slot',
        )
    }

    let account: TAccount
    try {
        account = await identifyAccount(legacyToken.token)
    } catch (error) {
        return skipped(silent, logPrefix, 'identify-failed', getErrorMessage(error))
    }

    // Don't clobber an existing v2 record. A `marker-write-failed` retry
    // may land on a store where the user has since completed a v2 login
    // (with a refresh token + expiry on the record). `userRecords.upsert`
    // is replace-not-merge, so writing the legacy access-only bundle here
    // would wipe `hasRefreshToken` / expiry and silently disable silent
    // refresh. The legacy token has no authority over refresh state.
    //
    // Prefer the atomic `tryInsert` when the consumer supplies it —
    // eliminates the TOCTOU race between a list-based existence check and
    // the write. Fall back to list-then-write when not implemented; the
    // race window is small (microseconds for in-process upserts) and
    // acceptable for typical postinstall-style invocations.
    try {
        const accountSlot = accountForUser(account.id)
        const accessStore = createSecureStore({ serviceName, account: accountSlot })
        const refreshStore = createSecureStore({
            serviceName,
            account: refreshAccountSlot(accountSlot),
        })

        if (userRecords.tryInsert) {
            // `tryInsert` proves the record was absent at insert time but
            // gives no exclusive ownership afterward — a v2 login can
            // start, complete `setSecret` + `upsert`, and reach the
            // refresh slot all while we're between our own steps.
            // Without ownership checks the migration would clobber the
            // very v2 login it's meant to preserve: our `setSecret`
            // would overwrite their access token, our follow-up `upsert`
            // would reset their record, our `deleteSecret` would wipe
            // their refresh slot.
            //
            // We re-read before each follow-up and abort the rest if the
            // record is no longer the placeholder we inserted (matched
            // by `fallbackToken === legacyToken.token` AND no
            // `hasRefreshToken` advertised — together a unique signature
            // of our migration's tryInsert payload, never produced by a
            // v2 login). The race window is now bounded by the gap
            // between re-read and the very next call, not the entire
            // multi-step sequence.
            //
            // If we already moved the secret into the keyring before
            // discovering we lost ownership, roll that write back so we
            // don't leave a stale access token in the slot. The v2
            // login's `setSecret` may have run after ours; rolling back
            // to "no entry" is the only safe end-state we can guarantee
            // without contract-level CAS, and v2 login's keyring-write
            // path is happy to re-create.
            const legacyTokenStr = legacyToken.token
            const placeholder = {
                account,
                fallbackToken: legacyTokenStr,
                hasRefreshToken: undefined,
            }
            async function recordStillOurs(): Promise<boolean> {
                const current = findById(await userRecords.list(), account.id)
                return (
                    current?.fallbackToken === legacyTokenStr &&
                    current?.hasRefreshToken === undefined
                )
            }
            const inserted = await userRecords.tryInsert(placeholder)
            if (inserted && (await recordStillOurs())) {
                // Shared keyring-online/offline policy with
                // `writeRecordWithKeyringFallback`: only the documented
                // `SecureStoreUnavailableError` downgrades to "keep the
                // plaintext fallback"; everything else propagates.
                const movedToKeyring = await trySetSecret(accessStore, legacyTokenStr)
                // One ownership re-read after the keyring write; cache the
                // result so the follow-up upsert AND the refresh-slot
                // cleanup share the same answer. The earlier code re-read
                // again after the upsert, but the upsert flips
                // `hasRefreshToken` away from the placeholder signature
                // so that check was guaranteed to return false (and the
                // cleanup silently skipped).
                const stillOurs = await recordStillOurs()
                if (movedToKeyring && stillOurs) {
                    await userRecords.upsert({ account, hasRefreshToken: false })
                } else if (movedToKeyring) {
                    // V2 login took over after our setSecret. Only roll
                    // the keyring write back when the slot still contains
                    // OUR legacy token — a blind delete would otherwise
                    // remove v2's credential (their setSecret may have
                    // run after ours), leaving the v2 record permanently
                    // unreadable.
                    try {
                        const current = (await accessStore.getSecret())?.trim()
                        if (current === legacyTokenStr) {
                            await accessStore.deleteSecret().catch(() => undefined)
                        }
                    } catch {
                        // best-effort: if we can't read the slot, don't
                        // risk a destructive delete.
                    }
                }
                if (stillOurs) {
                    // Best-effort cleanup of any stale refresh secret
                    // (legacy single-user state never had one, but a
                    // hand-edit might). Skipped when v2 owns the record.
                    await refreshStore.deleteSecret().catch(() => undefined)
                }
            }
        } else {
            const existing = findById(await userRecords.list(), account.id)
            if (!existing) {
                await writeRecordWithKeyringFallback({
                    secureStore: accessStore,
                    refreshSecureStore: refreshStore,
                    userRecords,
                    account,
                    bundle: { accessToken: legacyToken.token },
                    // The list-then-write fallback can still race with a
                    // parallel v2 login that writes a refresh secret
                    // between our `list()` and the helper's `upsert`.
                    // `purgeRefreshSlot: false` keeps the refresh slot
                    // untouched and persists `hasRefreshToken: undefined`
                    // ("unknown" — readers probe the slot) so a v2
                    // refresh secret written mid-race remains visible.
                    purgeRefreshSlot: false,
                })
            }
        }
    } catch (error) {
        return skipped(silent, logPrefix, 'user-record-write-failed', getErrorMessage(error))
    }

    // Default promotion is best-effort and **only fires when nothing is
    // already pinned**. A retry after a previous `markMigrated()` failure
    // can land on a store where the user has since logged in to a different
    // account and picked it as default — blindly setting the legacy account
    // back as default would silently switch the user.
    try {
        const existingDefault = await userRecords.getDefaultId()
        if (!existingDefault) {
            await userRecords.setDefaultId(account.id)
        }
    } catch {
        // best-effort
    }

    // Persist the one-way marker BEFORE legacy cleanup. If this fails, the
    // v2 record is already written but the gate is unset — surface as
    // `skipped` so the caller retries. Without this ordering, a later
    // `logout` could let the next run re-migrate the stale v1 token.
    try {
        await markMigrated()
    } catch (error) {
        return skipped(silent, logPrefix, 'marker-write-failed', getErrorMessage(error))
    }

    // Best-effort legacy cleanup — runs concurrently so we don't pay
    // keyring latency followed by config-write latency on every install.
    // The marker is already set, so a failure here can't cause
    // re-migration on the next run. The `Promise.resolve().then(...)`
    // wrappers convert any *synchronous* throw from a consumer-supplied
    // `cleanupLegacyConfig` (or an oddly-implemented `SecureStore`) into
    // a rejected promise that `Promise.allSettled` can swallow.
    await Promise.allSettled([
        Promise.resolve().then(() => legacyStore.deleteSecret()),
        Promise.resolve().then(() => cleanupLegacyConfig?.()),
    ])

    if (!silent) {
        // No identifier in the log line — `account.id` is typed as `string`
        // but consumers can legitimately use an email or other PII there.
        // Callers that need richer telemetry can compose it from the
        // returned `account`.
        console.error(`${logPrefix}: migrated existing token to multi-user store.`)
    }

    return { status: 'migrated', account }
}

async function readLegacyToken(
    legacyStore: SecureStore,
    loadLegacyPlaintextToken: () => Promise<string | null>,
): Promise<LegacyTokenResult> {
    let keyringUnavailable = false
    try {
        const stored = await legacyStore.getSecret()
        if (stored?.trim()) return { kind: 'found', token: stored.trim() }
    } catch (error) {
        if (!(error instanceof SecureStoreUnavailableError)) throw error
        keyringUnavailable = true
    }

    const plaintext = await loadLegacyPlaintextToken()
    if (plaintext?.trim()) return { kind: 'found', token: plaintext.trim() }

    return keyringUnavailable ? { kind: 'keyring-unavailable' } : { kind: 'none' }
}

/**
 * Emit the migration skip line. The stderr text is a fixed phrase keyed off
 * `MigrateSkipReason` so consumer-supplied callbacks (`identifyAccount`,
 * the `UserRecordStore`, …) can't leak emails, paths, or auth diagnostics
 * into logs. The raw error message is still attached to the returned
 * `MigrateAuthResult.detail` for in-process callers that need it.
 */
function skipped<TAccount extends AuthAccount>(
    silent: boolean | undefined,
    logPrefix: string,
    reason: MigrateSkipReason,
    detail: string,
): MigrateAuthResult<TAccount> {
    if (!silent) {
        console.error(
            `${logPrefix}: skipped legacy auth migration — ${SKIP_REASON_MESSAGES[reason]}.`,
        )
    }
    return { status: 'skipped', reason, detail }
}
