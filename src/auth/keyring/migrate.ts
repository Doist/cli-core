import { getErrorMessage } from '../../errors.js'
import type { AuthAccount } from '../types.js'
import { readAccessTokenForRecord } from './internal.js'
import { buildSingleTokenRecord } from './record-write.js'
import {
    createSecureStore,
    DEFAULT_ACCOUNT_FOR_USER,
    type SecureStore,
    SecureStoreUnavailableError,
} from './secure-store.js'
import type { UserRecord, UserRecordStore } from './types.js'

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
 * Stable skip reasons. `*-keyring-unreachable` variants are retryable (a
 * later run with the keyring online would succeed); the others are
 * diagnostic.
 */
export type MigrateSkipReason =
    | 'identify-failed'
    | 'legacy-keyring-unreachable'
    | 'user-keyring-unreachable'
    | 'user-record-write-failed'
    | 'marker-write-failed'

const SKIP_REASON_MESSAGES: Record<MigrateSkipReason, string> = {
    'identify-failed': 'could not identify user',
    'legacy-keyring-unreachable': 'legacy credential is unreachable (keyring offline)',
    'user-keyring-unreachable': 'per-user credential slot is unreachable (keyring offline)',
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
 * shape. Best-effort: any failure leaves v1 untouched so the runtime
 * fallback keeps serving the legacy token until the next attempt.
 *
 * Order is deliberate so the migration is one-way AND safe under retry:
 *
 *   1. `hasMigrated()` short-circuits when the marker is set.
 *   2. Read the v1 token (legacy keyring first, then plaintext).
 *   3. `identifyAccount(token)` resolves the v2 `account`.
 *   4. **Phase 1** — `ensureV2Record` writes a fallback-bearing record (or
 *      no-ops when a v2 record already exists).
 *   5. **Phase 2** — when Phase 1 wrote: move the token to the per-user
 *      keyring slot and upsert the clean record. When Phase 1 didn't:
 *      verify the existing record is readable before retiring legacy.
 *   6. Best-effort `setDefaultId(account.id)`.
 *   7. `markMigrated()` — the one-way gate. Failure here surfaces as
 *      `skipped(marker-write-failed)` so the caller retries.
 *   8. Best-effort legacy cleanup runs concurrently.
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

    let phase1: Phase1Result<TAccount>
    try {
        phase1 = await ensureV2Record(userRecords, account, legacyToken.token)
    } catch (error) {
        return skipped(silent, logPrefix, 'user-record-write-failed', getErrorMessage(error))
    }

    const userSlot = createSecureStore({
        serviceName,
        account: accountForUser(account.id),
    })

    // Run Phase 2 when EITHER Phase 1 just wrote the fallback record OR
    // the existing record's fallback matches our legacy token — that's a
    // prior-run Phase 1 we owe an upgrade. Other existing records are
    // external state and get a readability check instead.
    const isOurPriorPhase1 =
        !phase1.written && phase1.existing.fallbackToken?.trim() === legacyToken.token
    if (phase1.written || isOurPriorPhase1) {
        const phase2Error = await runPhase2(userRecords, userSlot, account, legacyToken.token)
        if (phase2Error) {
            return skipped(silent, logPrefix, phase2Error.reason, phase2Error.detail)
        }
    } else {
        // External record — cleaning up legacy is safe only if it can be
        // read in the current environment.
        const outcome = await readAccessTokenForRecord(phase1.existing, userSlot)
        if (!outcome.ok) {
            const reason: MigrateSkipReason =
                outcome.reason === 'slot-unavailable'
                    ? 'user-keyring-unreachable'
                    : 'user-record-write-failed'
            return skipped(silent, logPrefix, reason, outcome.detail)
        }
    }

    // Only promote when nothing is pinned — a retry must not overwrite a
    // default the user chose between attempts.
    try {
        const existingDefault = await userRecords.getDefaultId()
        if (!existingDefault) {
            await userRecords.setDefaultId(account.id)
        }
    } catch {
        // best-effort
    }

    // Marker BEFORE cleanup: the gate, not cleanup, is what prevents the
    // next run from re-migrating after a later `logout`.
    try {
        await markMigrated()
    } catch (error) {
        return skipped(silent, logPrefix, 'marker-write-failed', getErrorMessage(error))
    }

    // `Promise.resolve().then(...)` converts any *synchronous* throw from
    // a consumer's `cleanupLegacyConfig` into a rejection that
    // `allSettled` can swallow.
    await Promise.allSettled([
        Promise.resolve().then(() => legacyStore.deleteSecret()),
        Promise.resolve().then(() => cleanupLegacyConfig?.()),
    ])

    if (!silent) {
        // Account id may carry PII (email, etc.) — keep it out of logs.
        console.error(`${logPrefix}: migrated existing token to multi-user store.`)
    }

    return { status: 'migrated', account }
}

type Phase1Result<TAccount extends AuthAccount> =
    | { written: true }
    | { written: false; existing: UserRecord<TAccount> }

/**
 * Phase 1. Writes a `fallbackToken`-bearing record so a crash before
 * Phase 2 still leaves a working credential. Returns `{ written: true }`
 * when this call wrote, or `{ written: false, existing }` when a v2
 * record already existed — the existing record is returned so callers
 * decide whether to upgrade it (Phase 2 retry) or treat it as external
 * state, without paying a second `list()`.
 */
async function ensureV2Record<TAccount extends AuthAccount>(
    userRecords: UserRecordStore<TAccount>,
    account: TAccount,
    legacyToken: string,
): Promise<Phase1Result<TAccount>> {
    const record = buildSingleTokenRecord(account, legacyToken)
    if (userRecords.tryInsert) {
        const wrote = await userRecords.tryInsert(record)
        if (wrote) return { written: true }
        const existing = (await userRecords.list()).find((r) => r.account.id === account.id)
        if (!existing) {
            throw new Error('tryInsert returned false but no matching record was listed')
        }
        return { written: false, existing }
    }
    // Non-atomic path. Narrow time-of-check, time-of-use race between
    // `list()` and `upsert()`; acceptable for one-time migration since
    // concurrent runs would write the same shape.
    const all = await userRecords.list()
    const existing = all.find((r) => r.account.id === account.id)
    if (existing) return { written: false, existing }
    await userRecords.upsert(record)
    return { written: true }
}

/**
 * Phase 2: move the legacy token into the per-user keyring slot and
 * upsert a clean (no `fallbackToken`) record. Inlined rather than
 * delegating to `writeRecordWithKeyringFallback` so the offline-keyring
 * branch doesn't double-upsert the same fallback record Phase 1 just
 * wrote. Returns `null` on success (including the silently-handled
 * SecureStoreUnavailable case); a skip descriptor when a non-keyring
 * failure leaves the marker unset for retry.
 */
async function runPhase2<TAccount extends AuthAccount>(
    userRecords: UserRecordStore<TAccount>,
    userSlot: SecureStore,
    account: TAccount,
    legacyToken: string,
): Promise<{ reason: MigrateSkipReason; detail: string } | null> {
    try {
        await userSlot.setSecret(legacyToken)
    } catch (error) {
        if (error instanceof SecureStoreUnavailableError) {
            return null // Phase 1 fallback record continues to serve reads.
        }
        return { reason: 'user-record-write-failed', detail: getErrorMessage(error) }
    }
    try {
        await userRecords.upsert(buildSingleTokenRecord(account))
    } catch (error) {
        return { reason: 'user-record-write-failed', detail: getErrorMessage(error) }
    }
    return null
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
