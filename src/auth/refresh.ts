import { closeSync, openSync, unlinkSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'
import { CliError } from '../errors.js'
import { persistBundle } from './persist.js'
import type { AccountRef, AuthAccount, AuthProvider, TokenBundle, TokenStore } from './types.js'
import { requireSnapshotForRef } from './user-flag.js'

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
     * `accessTokenExpiresAt`. Default 60s. Set to `0` for "only refresh
     * when fully expired"; set to `Infinity` to force a refresh whenever a
     * refresh token exists.
     */
    skewMs?: number
    /**
     * Force a refresh regardless of expiry — used by the reactive 401-retry
     * path where the server has already rejected the access token. Throws
     * `AUTH_REFRESH_UNAVAILABLE` when no refresh token is stored. Honored
     * only when the post-lock re-read still returns the same access token
     * (so a concurrent process that refreshed first wins).
     */
    force?: boolean
    /**
     * Absolute filesystem path to a sidecar lock file. When provided, the
     * helper acquires it via `O_EXCL` before refreshing so two concurrent
     * processes don't race the server's refresh-token rotation. When
     * omitted, no cross-process lock is taken (single-process safety only).
     * Pass an expanded path (no `~`); cli-core does not interpret it.
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
 * Concurrency: when `lockPath` is supplied, the helper acquires it before
 * refreshing. On contention it waits up to `lockTimeoutMs`, then re-reads
 * the store — if another process has already refreshed (detected by a
 * changed access token), the fresh bundle is returned without firing a
 * duplicate POST, even when `force` was set. If the lock can't be acquired
 * the refresh proceeds anyway (worst case: one extra token rotation).
 */
export async function refreshAccessToken<TAccount extends AuthAccount>(
    options: RefreshAccessTokenOptions<TAccount>,
): Promise<{ token: string; bundle: TokenBundle; account: TAccount }> {
    const skewMs = options.skewMs ?? DEFAULT_SKEW_MS
    const lockTimeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS

    const snapshot = await requireSnapshotForRef(options.store, options.ref)
    if (!snapshot) {
        throw new CliError('NOT_AUTHENTICATED', 'No stored credentials to refresh.')
    }
    // Synthesise a minimal bundle for stores that don't track refresh state —
    // they'll fall through to `AUTH_REFRESH_UNAVAILABLE` below since
    // `refreshToken` is missing, which is the right behaviour.
    const initialBundle: TokenBundle = snapshot.bundle ?? { accessToken: snapshot.token }
    if (!shouldRefresh(initialBundle, skewMs, options.force ?? false)) {
        return { token: snapshot.token, bundle: initialBundle, account: snapshot.account }
    }
    if (!initialBundle.refreshToken) {
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

    const lock = options.lockPath ? await acquireFileLock(options.lockPath, lockTimeoutMs) : null

    let bundle = initialBundle
    let account = snapshot.account
    try {
        // Re-read inside the lock. Another process may have refreshed already;
        // when that happened, its rotated access token will differ from ours
        // and we MUST return the fresh result instead of firing our own
        // refresh — even on the `force` path. Continuing would POST with our
        // (now-rotated, invalid) refresh token and yield `invalid_grant`.
        if (lock) {
            const fresh = await requireSnapshotForRef(options.store, options.ref)
            if (fresh) {
                const freshBundle = fresh.bundle ?? { accessToken: fresh.token }
                if (fresh.token !== snapshot.token) {
                    // Another process won the race. Return its result; ignore
                    // our `force` flag because the access token has already
                    // been rotated server-side.
                    return { token: fresh.token, bundle: freshBundle, account: fresh.account }
                }
                if (!shouldRefresh(freshBundle, skewMs, options.force ?? false)) {
                    return { token: fresh.token, bundle: freshBundle, account: fresh.account }
                }
                bundle = freshBundle
                account = fresh.account
            }
        }

        const buildHandshake =
            options.buildHandshake ??
            ((acc: TAccount): Record<string, unknown> => ({ ...acc, flags: {} }))

        const exchange = await options.provider.refreshToken({
            refreshToken: bundle.refreshToken!,
            account,
            handshake: buildHandshake(account),
        })

        // Honour an `account` returned by the provider — refresh responses
        // can legitimately carry updated identity (server-side rename,
        // re-resolved label) that callers want to see. Defaults to the
        // pre-refresh account when the provider doesn't return one.
        const refreshedAccount = exchange.account ?? account

        const nextBundle: TokenBundle = {
            accessToken: exchange.accessToken,
            // Rotate when the server returns one, keep the previous when it
            // doesn't.
            refreshToken: exchange.refreshToken ?? bundle.refreshToken,
            accessTokenExpiresAt: exchange.expiresAt,
            refreshTokenExpiresAt: exchange.refreshTokenExpiresAt ?? bundle.refreshTokenExpiresAt,
        }

        await persistBundle(options.store, refreshedAccount, nextBundle)
        return {
            token: nextBundle.accessToken,
            bundle: nextBundle,
            account: refreshedAccount,
        }
    } finally {
        if (lock) lock.release()
    }
}

function shouldRefresh(bundle: TokenBundle, skewMs: number, force: boolean): boolean {
    if (force) return true
    if (typeof bundle.accessTokenExpiresAt !== 'number') return false
    return Date.now() > bundle.accessTokenExpiresAt - skewMs
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
                // ENOENT on a missing dir, EACCES, … bubble up so the caller
                // proceeds without the lock.
                return null
            }
            if (Date.now() >= deadline) return null
            await sleep(LOCK_POLL_INTERVAL_MS)
        }
    }
}
