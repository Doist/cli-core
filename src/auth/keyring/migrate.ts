import { getErrorMessage } from '../../errors.js'
import type { AuthAccount } from '../types.js'
import { buildSingleTokenRecord } from './record-write.js'
import {
    createSecureStore,
    DEFAULT_ACCOUNT_FOR_USER,
    type SecureStore,
    SecureStoreUnavailableError,
} from './secure-store.js'
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
 * Order of operations is deliberate so the migration is genuinely one-way
 * AND safe under retry:
 *
 *   1. `hasMigrated()` short-circuits if the durable marker is already set.
 *   2. Read the v1 token (legacy keyring slot first, then plaintext).
 *   3. `identifyAccount(token)` resolves the v2 `account` shape.
 *   4. **Phase 1 (record-first)**: ensure a v2 record exists for the
 *      account, written with `fallbackToken: legacyToken` so reads work
 *      even before Phase 2 lands. Atomic via `UserRecordStore.tryInsert?`
 *      when available; otherwise list-then-upsert (narrow TOCTOU window,
 *      tolerable for one-time migration). When a v2 record for the
 *      account already exists, Phase 1 is a no-op and Phase 2 is
 *      skipped — preserving any later state that may have landed via a
 *      fresh login.
 *   5. **Phase 2 (keyring move)**: only when Phase 1 wrote the record.
 *      `setSecret` moves the token into the per-user keyring slot, then
 *      a clean `upsert` clears `fallbackToken`. Best-effort throughout —
 *      a failure leaves the Phase 1 fallback in place and reads continue
 *      to work; a later `set()` or `setBundle()` upgrades the credential.
 *   6. Best-effort `setDefaultId(account.id)` so the new record is active.
 *   7. `markMigrated()` persists the marker. **If this fails, we return
 *      `skipped` even though the v2 record is on disk** — the marker is
 *      what prevents re-migration on the next run.
 *   8. Best-effort legacy keyring delete + `cleanupLegacyConfig()` run
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

    // Phase 1: ensure a v2 record exists. Either we write a self-sufficient
    // fallback-bearing record (the token survives a Phase 2 crash), or a
    // v2 record was already there from a fresh login and we leave it alone.
    let phase1Wrote: boolean
    try {
        phase1Wrote = await ensureV2Record(userRecords, account, legacyToken.token)
    } catch (error) {
        return skipped(silent, logPrefix, 'user-record-write-failed', getErrorMessage(error))
    }

    const userSlot = createSecureStore({
        serviceName,
        account: accountForUser(account.id),
    })

    if (phase1Wrote) {
        // Phase 2: move the token from `fallbackToken` into the per-user
        // keyring slot. Inlined (rather than delegating to
        // `writeRecordWithKeyringFallback`) so the offline-keyring path
        // doesn't double-upsert — Phase 1 already wrote the fallback
        // record. Only `SecureStoreUnavailableError` is swallowed; other
        // failures leave the marker unset so the operator can retry.
        let keyringStored = false
        try {
            await userSlot.setSecret(legacyToken.token)
            keyringStored = true
        } catch (error) {
            if (!(error instanceof SecureStoreUnavailableError)) {
                return skipped(
                    silent,
                    logPrefix,
                    'user-record-write-failed',
                    getErrorMessage(error),
                )
            }
            // Phase 1's fallback record already serves reads. Fall through.
        }
        if (keyringStored) {
            // Promote the record to the clean shape (no fallback) so the
            // plaintext copy doesn't outlive the secure-store write.
            try {
                await userRecords.upsert(buildSingleTokenRecord(account))
            } catch (error) {
                return skipped(
                    silent,
                    logPrefix,
                    'user-record-write-failed',
                    getErrorMessage(error),
                )
            }
        }
    } else {
        // Existing v2 record: verify it's readable in the current
        // environment before retiring the legacy state. A record from a
        // prior `set()` / `setBundle()` has no `fallbackToken` and depends
        // on the keyring being reachable; if it isn't, cleaning up legacy
        // would brick the user.
        const readabilityError = await verifyExistingRecordReadable(userRecords, account, userSlot)
        if (readabilityError) {
            return skipped(silent, logPrefix, readabilityError.reason, readabilityError.detail)
        }
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

/**
 * Phase 1 of the migration write. Atomic when the store exposes
 * `tryInsert?`; otherwise list-then-upsert.
 *
 * Returns `true` when this call wrote the record (Phase 2 should proceed);
 * `false` when a v2 record for the account already existed (Phase 2 must be
 * skipped to preserve any later state).
 *
 * The Phase 1 shape is deliberately `fallbackToken`-bearing rather than
 * keyring-first: a crash between Phase 1 and Phase 2 leaves a record that
 * already works for reads. Phase 2 promotes the credential to the keyring;
 * if it crashes too, the next migration retry will pick up where this one
 * left off.
 */
async function ensureV2Record<TAccount extends AuthAccount>(
    userRecords: UserRecordStore<TAccount>,
    account: TAccount,
    legacyToken: string,
): Promise<boolean> {
    const record = buildSingleTokenRecord(account, legacyToken)
    if (userRecords.tryInsert) {
        return userRecords.tryInsert(record)
    }
    // Non-atomic fallback. Narrow race window between `list()` and
    // `upsert()` (time-of-check, time-of-use): a concurrent writer could
    // sneak a record in between the two calls and our upsert would
    // replace-not-merge it. Tolerable for one-time migration — concurrent
    // migration runs would write the same shape anyway, and the user
    // typically isn't running other auth writes simultaneously.
    const existing = await userRecords.list()
    if (existing.some((r) => r.account.id === account.id)) return false
    await userRecords.upsert(record)
    return true
}

/**
 * After Phase 1 returns `false` (existing v2 record), verify the record is
 * actually readable in the current environment before retiring the legacy
 * state. A clean v2 record from a prior `set()` / `setBundle()` has no
 * `fallbackToken` and depends on the keyring being reachable; if it isn't,
 * cleaning up the legacy slot would brick the user.
 *
 * Returns `null` when the existing record is safely readable. Returns a
 * skip descriptor when it isn't — the caller surfaces the migration as
 * `skipped` without touching the legacy state, so the next retry has a
 * working credential to fall back to.
 */
async function verifyExistingRecordReadable<TAccount extends AuthAccount>(
    userRecords: UserRecordStore<TAccount>,
    account: TAccount,
    userSlot: SecureStore,
): Promise<{ reason: MigrateSkipReason; detail: string } | null> {
    const existing = (await userRecords.list()).find((r) => r.account.id === account.id)
    if (existing?.fallbackToken?.trim()) return null
    try {
        const raw = await userSlot.getSecret()
        if (raw?.trim()) return null
        return {
            reason: 'user-record-write-failed',
            detail: 'existing v2 record has no fallback token and its keyring slot is empty',
        }
    } catch (error) {
        if (error instanceof SecureStoreUnavailableError) {
            return {
                reason: 'legacy-keyring-unreachable',
                detail: 'existing v2 record has no fallback token and the per-user keyring slot is unreachable',
            }
        }
        return {
            reason: 'user-record-write-failed',
            detail: getErrorMessage(error),
        }
    }
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
