import { closeSync, openSync, unlinkSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'
import { CliError } from '../errors.js'
import type { AccountRef, AuthAccount, AuthProvider, TokenBundle, TokenStore } from './types.js'

/** Default skew window: refresh when fewer than 60s remain on the access token. */
const DEFAULT_SKEW_MS = 60_000
/** Default file-lock acquisition window. Two seconds covers the median refresh round-trip. */
const DEFAULT_LOCK_TIMEOUT_MS = 2_000
const LOCK_POLL_INTERVAL_MS = 100

export type RefreshAccessTokenOptions<TAccount extends AuthAccount> = {
    store: TokenStore<TAccount>
    provider: AuthProvider<TAccount>
    /** Target a stored account by ref (defaults to the active default). */
    ref?: AccountRef
    /**
     * Build the handshake the provider's `refreshToken` will see. Defaults
     * to `{ ...account, flags: {} }`. Outline needs the `baseUrl` /
     * `oauthClientId` on the account — both flow through automatically.
     */
    buildHandshake?: (account: TAccount) => Record<string, unknown>
    /**
     * Refresh when fewer than this many ms remain on the access token's
     * `expiresAt`. Default 60s. Set to `0` for "only refresh when fully
     * expired"; set to `Infinity` to force a refresh whenever a refresh
     * token exists.
     */
    skewMs?: number
    /**
     * Force a refresh regardless of expiry — used by the reactive 401-retry
     * path where the server has already rejected the access token. Throws
     * `AUTH_REFRESH_UNAVAILABLE` when no refresh token is stored.
     */
    force?: boolean
    /**
     * Sidecar lock file path. Defaults to `${store.getRecordsLocation()}.refresh.lock`
     * when the store is a `KeyringTokenStore` exposing `getRecordsLocation`,
     * otherwise no file lock is used (single-process safety only).
     */
    lockPath?: string
    /** Lock acquisition window. Default 2_000ms. */
    lockTimeoutMs?: number
}

/**
 * Read the active credentials; refresh them when the access token is past
 * its skew window (proactive) or `force` is set (reactive 401 path). Persists
 * the new bundle and returns it. When refresh isn't needed the active bundle
 * is returned unchanged.
 *
 * Concurrency: when a sidecar lock file path is available, the helper acquires
 * it before refreshing. On contention it waits up to `lockTimeoutMs`, then
 * re-reads the store — if another process has already refreshed, the fresh
 * bundle is returned without firing a duplicate POST. If the lock can't be
 * acquired the refresh proceeds anyway (worst case: one extra token rotation).
 */
export async function refreshAccessToken<TAccount extends AuthAccount>(
    options: RefreshAccessTokenOptions<TAccount>,
): Promise<{ token: string; bundle: TokenBundle; account: TAccount }> {
    const skewMs = options.skewMs ?? DEFAULT_SKEW_MS
    const lockTimeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS

    const snapshot = await options.store.active(options.ref)
    if (!snapshot) {
        throw new CliError('NOT_AUTHENTICATED', 'No stored credentials to refresh.')
    }
    // Synthesise a minimal bundle for stores that don't track refresh state —
    // they'll fall through to `AUTH_REFRESH_UNAVAILABLE` below since
    // `refreshToken` is missing, which is the right behaviour.
    const bundle: TokenBundle = snapshot.bundle ?? { accessToken: snapshot.token }
    const resolvedSnapshot = { token: snapshot.token, bundle, account: snapshot.account }
    if (!shouldRefresh(bundle, skewMs, options.force ?? false)) {
        return resolvedSnapshot
    }
    if (!bundle.refreshToken) {
        throw new CliError(
            'AUTH_REFRESH_UNAVAILABLE',
            'Access token expired and no refresh token is stored.',
        )
    }
    if (!options.provider.refreshToken) {
        throw new CliError(
            'AUTH_REFRESH_UNAVAILABLE',
            "Auth provider does not implement 'refreshToken'.",
        )
    }

    const lockPath = options.lockPath ?? deriveLockPath(options.store)
    const lock = lockPath ? await acquireFileLock(lockPath, lockTimeoutMs) : null

    try {
        // Re-read inside the lock: another process may have refreshed
        // already, and re-using its result avoids two refreshes racing the
        // server's rotation logic (the loser's refresh token would be void).
        if (lock) {
            const fresh = await options.store.active(options.ref)
            if (fresh) {
                const freshBundle = fresh.bundle ?? { accessToken: fresh.token }
                if (!shouldRefresh(freshBundle, skewMs, options.force ?? false)) {
                    return { token: fresh.token, bundle: freshBundle, account: fresh.account }
                }
            }
        }

        const buildHandshake =
            options.buildHandshake ??
            ((account: TAccount): Record<string, unknown> => ({ ...account, flags: {} }))

        const exchange = await options.provider.refreshToken({
            refreshToken: bundle.refreshToken,
            account: snapshot.account,
            handshake: buildHandshake(snapshot.account),
        })

        const nextBundle: TokenBundle = {
            accessToken: exchange.accessToken,
            // Rotate when the server returns one, keep the previous when it
            // doesn't. Same logic the spec calls out for refresh rotation.
            refreshToken: exchange.refreshToken ?? bundle.refreshToken,
            accessTokenExpiresAt: exchange.accessTokenExpiresAt,
            refreshTokenExpiresAt: exchange.refreshTokenExpiresAt ?? bundle.refreshTokenExpiresAt,
        }

        await options.store.set(snapshot.account, nextBundle)
        return { token: nextBundle.accessToken, bundle: nextBundle, account: snapshot.account }
    } finally {
        if (lock) lock.release()
    }
}

function shouldRefresh(bundle: TokenBundle, skewMs: number, force: boolean): boolean {
    if (force) return true
    if (typeof bundle.accessTokenExpiresAt !== 'number') return false
    return Date.now() > bundle.accessTokenExpiresAt - skewMs
}

function deriveLockPath<TAccount extends AuthAccount>(
    store: TokenStore<TAccount>,
): string | undefined {
    const candidate = store as { getRecordsLocation?: () => string }
    if (typeof candidate.getRecordsLocation === 'function') {
        return `${candidate.getRecordsLocation()}.refresh.lock`
    }
    return undefined
}

type FileLock = { release: () => void }

/**
 * Hand-rolled lock via `O_EXCL` open of a sidecar file. On contention the
 * caller waits up to `timeoutMs` for the holder to release, polling every
 * `LOCK_POLL_INTERVAL_MS`. Returns `null` rather than throwing on timeout —
 * the caller should still attempt the refresh (worst case is duplicate POST,
 * recoverable). Stale locks from crashed processes are not detected; the
 * trade-off matches the cost of correctness vs. complexity for a CLI.
 */
async function acquireFileLock(path: string, timeoutMs: number): Promise<FileLock | null> {
    const deadline = Date.now() + timeoutMs
    while (true) {
        try {
            const fd = openSync(path, 'wx')
            closeSync(fd)
            return {
                release() {
                    try {
                        unlinkSync(path)
                    } catch {
                        // best-effort: another process may have force-cleaned
                    }
                },
            }
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
                // ENOENT on a missing dir is the only other realistic case;
                // bubble up so the caller proceeds without the lock.
                return null
            }
            if (Date.now() >= deadline) return null
            await sleep(LOCK_POLL_INTERVAL_MS)
        }
    }
}
