import { open, stat, unlink } from 'node:fs/promises'
import { setTimeout as sleep } from 'node:timers/promises'
import { CliError, getErrorMessage } from '../errors.js'
import { bundleFromExchange, persistBundle } from './persist.js'
import type { AccountRef, AuthAccount, AuthProvider, TokenBundle, TokenStore } from './types.js'

export type RefreshAccessTokenOptions<TAccount extends AuthAccount> = {
    store: TokenStore<TAccount>
    provider: AuthProvider<TAccount>
    ref?: AccountRef
    /**
     * Refresh proactively when the access token's expiry is within this many
     * ms of now. Default 60_000 (60s). Ignored when `force: true`.
     */
    skewMs?: number
    /**
     * Reactive path: caller hit a 401 and wants a rotation regardless of
     * expiry. Skips the skew check; still honours all the "unavailable"
     * gates (no refresh token, no provider hook, no `activeBundle`/`setBundle`).
     */
    force?: boolean
    /**
     * Path to the O_EXCL concurrency lock file. Required — cli-core does not
     * interpret `~` or know where the consumer's config lives. Recommended:
     * `${getConfigPath(serviceName)}.refresh.lock`.
     */
    lockPath: string
    /**
     * Forwarded to `provider.refreshToken` as its `handshake`, so consumers
     * can pass runtime context the provider's resolvers need (e.g. a
     * `--env`-derived base URL / client id). Defaults to `{}`.
     */
    handshake?: Record<string, unknown>
}

export type RefreshAccessTokenResult<TAccount extends AuthAccount> = {
    rotated: boolean
    bundle: TokenBundle
    account: TAccount
}

const DEFAULT_SKEW_MS = 60_000
const LOCK_WAIT_TIMEOUT_MS = 2_000
const LOCK_POLL_INTERVAL_MS = 50
// A lock older than this was almost certainly left by a crashed holder — the
// refresh POST is bounded by a provider-side timeout well under this — so it's
// safe to steal rather than block every future refresh forever.
const LOCK_STALE_MS = 15_000

/**
 * Rotate the access token using the stored refresh token. Proactive when
 * `accessTokenExpiresAt` is within `skewMs` of now; reactive when `force:
 * true`. Uses an `O_EXCL` file lock at `lockPath` so concurrent CLI
 * invocations don't issue parallel refresh-token grants — one POSTs, the
 * others re-read the rotated bundle from the store.
 *
 * Throws `AUTH_REFRESH_UNAVAILABLE` when refresh isn't possible in the
 * current setup: store doesn't implement `activeBundle` + `setBundle`,
 * provider doesn't implement `refreshToken`, no credential, or no refresh
 * token. Server-side rejections surface as `AUTH_REFRESH_EXPIRED` (re-login
 * required) or `AUTH_REFRESH_TRANSIENT` (retryable).
 */
export async function refreshAccessToken<TAccount extends AuthAccount>(
    options: RefreshAccessTokenOptions<TAccount>,
): Promise<RefreshAccessTokenResult<TAccount>> {
    const { store, provider, ref, force, lockPath } = options
    const skewMs = options.skewMs ?? DEFAULT_SKEW_MS
    const handshake = options.handshake ?? {}

    // Refresh must both read the full bundle and persist the rotated one. A
    // store missing either capability can't participate — fail loudly rather
    // than silently dropping the rotated refresh token via a `set()` fallback.
    if (!store.activeBundle || !store.setBundle) {
        throw new CliError(
            'AUTH_REFRESH_UNAVAILABLE',
            'TokenStore must implement activeBundle + setBundle for refresh.',
            { hints: ['Re-run the login command to reauthorize.'] },
        )
    }
    if (!provider.refreshToken) {
        throw new CliError(
            'AUTH_REFRESH_UNAVAILABLE',
            'Auth provider does not implement refreshToken.',
        )
    }
    const activeBundle = store.activeBundle.bind(store)
    const refreshGrant = provider.refreshToken.bind(provider)

    const snapshot = await activeBundle(ref)
    if (!snapshot) {
        throw new CliError('AUTH_REFRESH_UNAVAILABLE', 'No stored credential to refresh.', {
            hints: ['Re-run the login command to reauthorize.'],
        })
    }

    if (!force && !needsRefresh(snapshot.bundle, skewMs)) {
        return { rotated: false, bundle: snapshot.bundle, account: snapshot.account }
    }

    if (!snapshot.bundle.refreshToken) {
        throw new CliError('AUTH_REFRESH_UNAVAILABLE', 'Stored credential has no refresh token.', {
            hints: ['Re-run the login command to reauthorize.'],
        })
    }

    const acquired = await acquireLock(lockPath)
    if (!acquired) {
        // Holder didn't release in time. It may have rotated then crashed
        // before unlinking — re-read once and adopt the rotated bundle if so.
        const fresh = await activeBundle(ref)
        if (fresh && hasRotated(snapshot.bundle, fresh.bundle)) {
            return { rotated: true, bundle: fresh.bundle, account: fresh.account }
        }
        throw new CliError(
            'AUTH_REFRESH_TRANSIENT',
            'Timed out waiting for a concurrent refresh to complete.',
            { hints: ['Try again.'] },
        )
    }

    try {
        // Re-read under the lock (covers a clean acquire too): a concurrent
        // holder may have rotated between our snapshot read and acquiring the
        // lock, so adopt their bundle rather than POST a now-stale refresh
        // token. A throw here releases the lock via `finally`.
        const current = (await activeBundle(ref)) ?? snapshot
        if (hasRotated(snapshot.bundle, current.bundle)) {
            return { rotated: true, bundle: current.bundle, account: current.account }
        }
        const refreshToken = current.bundle.refreshToken
        if (!refreshToken) {
            throw new CliError(
                'AUTH_REFRESH_UNAVAILABLE',
                'Stored credential has no refresh token.',
                { hints: ['Re-run the login command to reauthorize.'] },
            )
        }
        const exchange = await refreshGrant({ refreshToken, handshake })
        const account = exchange.account ?? current.account
        const bundle = bundleFromExchange(exchange, current.bundle)
        await persistBundle({ store, account, bundle })
        return { rotated: true, bundle, account }
    } finally {
        await releaseLock(lockPath)
    }
}

function needsRefresh(bundle: TokenBundle, skewMs: number): boolean {
    // No expiry tracked → can't proactively refresh; defer to reactive 401.
    if (bundle.accessTokenExpiresAt === undefined) return false
    return bundle.accessTokenExpiresAt - Date.now() < skewMs
}

function hasRotated(before: TokenBundle, after: TokenBundle): boolean {
    if (after.accessToken !== before.accessToken) return true
    if (after.accessTokenExpiresAt !== before.accessTokenExpiresAt) return true
    return false
}

async function acquireLock(lockPath: string): Promise<boolean> {
    if (await tryAcquire(lockPath)) return true
    const deadline = Date.now() + LOCK_WAIT_TIMEOUT_MS
    while (Date.now() < deadline) {
        await sleep(LOCK_POLL_INTERVAL_MS)
        if (await tryAcquire(lockPath)) return true
    }
    return false
}

// Create the lock with O_EXCL. On EEXIST, steal it if it's stale (older than
// LOCK_STALE_MS — a crashed holder); otherwise report contention.
async function tryAcquire(lockPath: string): Promise<boolean> {
    if (await tryCreateLockFile(lockPath)) return true
    if (await lockIsStale(lockPath)) {
        await releaseLock(lockPath)
        return tryCreateLockFile(lockPath)
    }
    return false
}

async function lockIsStale(lockPath: string): Promise<boolean> {
    try {
        const { mtimeMs } = await stat(lockPath)
        return Date.now() - mtimeMs > LOCK_STALE_MS
    } catch {
        return false
    }
}

async function tryCreateLockFile(lockPath: string): Promise<boolean> {
    try {
        const handle = await open(lockPath, 'wx')
        await handle.close()
        return true
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code === 'EEXIST') return false
        throw new CliError(
            'AUTH_REFRESH_TRANSIENT',
            `Failed to acquire refresh lock: ${getErrorMessage(error)}`,
            { hints: ['Try again.'] },
        )
    }
}

async function releaseLock(lockPath: string): Promise<void> {
    try {
        await unlink(lockPath)
    } catch {
        // best-effort: a missing lock file (manual cleanup, crash, …) must
        // not surface as a refresh failure.
    }
}
