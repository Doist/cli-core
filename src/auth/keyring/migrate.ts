import { getErrorMessage } from '../../errors.js'
import type { AuthAccount } from '../types.js'
import { writeRecordWithKeyringFallback } from './record-write.js'
import {
    createSecureStore,
    DEFAULT_ACCOUNT_FOR_USER,
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
     * Failures are swallowed; the user record is the source of truth.
     */
    cleanupLegacyConfig?: () => Promise<void>
    /** Suppress stderr output (postinstall hooks set this). */
    silent?: boolean
    /** Label used in the stderr log line. Defaults to `'cli'`. */
    logPrefix?: string
}

export type MigrateAuthResult<TAccount extends AuthAccount = AuthAccount> = {
    status: 'already-migrated' | 'no-legacy-state' | 'migrated' | 'skipped'
    /**
     * Internal-only failure detail for the call site (e.g. doctor commands).
     * **Not** emitted to stderr — see `skipped()` for why.
     */
    reason?: string
    migratedAccount?: TAccount
}

/** Internal `SkipReason` codes — kept generic for stderr so consumer-supplied error text can't leak PII to logs. */
type SkipReason =
    | 'identify-failed'
    | 'keyring-write-failed'
    | 'user-record-write-failed'
    | 'cleanup-failed'

const SKIP_REASON_MESSAGES: Record<SkipReason, string> = {
    'identify-failed': 'could not identify user',
    'keyring-write-failed': 'failed to write user-scoped credential',
    'user-record-write-failed': 'failed to update user records',
    'cleanup-failed': 'failed to clean up legacy state',
}

/**
 * One-time migration of a v1 single-user auth state into a v2 multi-user
 * shape. Best-effort: any failure (offline keyring, network error fetching
 * the user, identifier mismatch, …) leaves the v1 state untouched so the
 * consumer's runtime fallback can keep serving the legacy token until the
 * next attempt.
 *
 * Steps:
 *   1. Skip if `userRecords` already has any records.
 *   2. Read the v1 token — legacy keyring slot first, then the consumer's
 *      plaintext slot.
 *   3. Identify the user via `identifyAccount(token)`.
 *   4. Write the token to the per-user keyring slot (or fall back to a
 *      `fallbackToken` on the record if keyring is unreachable).
 *   5. Upsert the v2 record + set it as the default.
 *   6. Best-effort delete of the legacy keyring slot.
 *   7. Best-effort `cleanupLegacyConfig()`.
 */
export async function migrateLegacyAuth<TAccount extends AuthAccount>(
    options: MigrateLegacyAuthOptions<TAccount>,
): Promise<MigrateAuthResult<TAccount>> {
    const {
        serviceName,
        legacyAccount,
        userRecords,
        loadLegacyPlaintextToken,
        identifyAccount,
        cleanupLegacyConfig,
        silent,
    } = options
    const accountForUser = options.accountForUser ?? DEFAULT_ACCOUNT_FOR_USER
    const logPrefix = options.logPrefix ?? 'cli'

    const existing = await userRecords.list()
    if (existing.length > 0) {
        return { status: 'already-migrated' }
    }

    const legacyToken = await readLegacyToken({
        serviceName,
        legacyAccount,
        loadLegacyPlaintextToken,
    })
    if (!legacyToken) {
        return { status: 'no-legacy-state' }
    }

    let account: TAccount
    try {
        account = await identifyAccount(legacyToken)
    } catch (error) {
        return skipped(silent, logPrefix, 'identify-failed', getErrorMessage(error))
    }

    try {
        await writeRecordWithKeyringFallback({
            serviceName,
            accountForUser,
            userRecords,
            account,
            token: legacyToken,
        })
    } catch (error) {
        // `writeRecordWithKeyringFallback` only rethrows non-keyring errors
        // (i.e. `userRecords.upsert` failures or unexpected keyring errors).
        // SecureStoreUnavailableError is internally caught by the helper and
        // never propagates here.
        return skipped(
            silent,
            logPrefix,
            error instanceof SecureStoreUnavailableError
                ? 'keyring-write-failed'
                : 'user-record-write-failed',
            getErrorMessage(error),
        )
    }

    // Default promotion is best-effort — the user record is durable and
    // `<cli> account use` can fix things up later.
    try {
        await userRecords.setDefaultId(account.id)
    } catch {
        // non-fatal
    }

    try {
        const legacyStore = createSecureStore({ serviceName, account: legacyAccount })
        await legacyStore.deleteSecret()
    } catch {
        // best-effort — legacy slot may already be empty or the keyring may be offline.
    }

    if (cleanupLegacyConfig) {
        try {
            await cleanupLegacyConfig()
        } catch {
            // best-effort — the user record is the source of truth.
        }
    }

    if (!silent) {
        // Log the stable id only — `account.label` is typically an email or
        // other user-facing identifier, and these diagnostics flow to stderr
        // (and possibly to log aggregators) where PII shouldn't appear.
        console.error(`${logPrefix}: migrated existing token to multi-user store (${account.id}).`)
    }

    return { status: 'migrated', migratedAccount: account }
}

async function readLegacyToken(opts: {
    serviceName: string
    legacyAccount: string
    loadLegacyPlaintextToken: () => Promise<string | null>
}): Promise<string | null> {
    try {
        const legacyStore = createSecureStore({
            serviceName: opts.serviceName,
            account: opts.legacyAccount,
        })
        const stored = await legacyStore.getSecret()
        if (stored?.trim()) return stored.trim()
    } catch (error) {
        if (!(error instanceof SecureStoreUnavailableError)) throw error
    }

    const plaintext = await opts.loadLegacyPlaintextToken()
    if (plaintext?.trim()) return plaintext.trim()

    return null
}

/**
 * Emit the migration skip line. The stderr text is a fixed phrase keyed off
 * `SkipReason` so consumer-supplied callbacks (`identifyAccount`, the
 * `UserRecordStore`, …) can't leak emails, paths, or auth diagnostics into
 * logs. The raw error message is still attached to the returned
 * `MigrateAuthResult.reason` for in-process callers that need it (doctor
 * commands, tests).
 */
function skipped<TAccount extends AuthAccount>(
    silent: boolean | undefined,
    logPrefix: string,
    reasonCode: SkipReason,
    detail: string,
): MigrateAuthResult<TAccount> {
    if (!silent) {
        console.error(
            `${logPrefix}: skipped legacy auth migration — ${SKIP_REASON_MESSAGES[reasonCode]}.`,
        )
    }
    return { status: 'skipped', reason: `${reasonCode}: ${detail}` }
}
