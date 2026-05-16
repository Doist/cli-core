import { getErrorMessage } from '../../errors.js'
import type { AuthAccount } from '../types.js'
import { writeRecordWithKeyringFallback } from './record-write.js'
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

    // `writeRecordWithKeyringFallback` swallows `SecureStoreUnavailableError`
    // internally (writing to `fallbackToken` instead), so any error here is
    // a non-keyring failure — typically a `userRecords.upsert` rejection.
    try {
        await writeRecordWithKeyringFallback({
            secureStore: createSecureStore({
                serviceName,
                account: accountForUser(account.id),
            }),
            userRecords,
            account,
            token: legacyToken.token,
        })
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
