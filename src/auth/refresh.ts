import { open, unlink } from 'node:fs/promises'
import { setTimeout as sleep } from 'node:timers/promises'
import { CliError, getErrorMessage } from '../errors.js'
import { bundleFromExchange, persistBundle } from './persist.js'
import type {
    AccountRef,
    ActiveBundleSnapshot,
    AuthAccount,
    AuthProvider,
    TokenBundle,
    TokenStore,
} from './types.js'

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
     * gates (no refresh token, no provider hook, no `activeBundle`).
     */
    force?: boolean
    /**
     * Path to the O_EXCL concurrency lock file. Required — cli-core does not
     * interpret `~` or know where the consumer's config lives. Recommended:
     * `${getConfigPath(serviceName)}.refresh.lock`.
     */
    lockPath: string
}

export type RefreshAccessTokenResult<TAccount extends AuthAccount> = {
    rotated: boolean
    bundle: TokenBundle
    account: TAccount
}

const DEFAULT_SKEW_MS = 60_000
const LOCK_WAIT_TIMEOUT_MS = 2_000
const LOCK_POLL_INTERVAL_MS = 50

/**
 * Rotate the access token using the stored refresh token. Proactive when
 * `accessTokenExpiresAt` is within `skewMs` of now; reactive when `force:
 * true`. Uses an `O_EXCL` file lock at `lockPath` so concurrent CLI
 * invocations don't issue parallel refresh-token grants — one POSTs, the
 * others re-read the rotated bundle from the store.
 *
 * Throws `AUTH_REFRESH_UNAVAILABLE` when refresh isn't possible in the
 * current setup: no refresh token stored, store doesn't implement
 * `activeBundle`, provider doesn't implement `refreshToken`, or
 * `oauth4webapi` isn't installed. Server-side rejections surface as
 * `AUTH_REFRESH_EXPIRED` (re-login required) or `AUTH_REFRESH_TRANSIENT`
 * (retryable).
 */
export async function refreshAccessToken<TAccount extends AuthAccount>(
    options: RefreshAccessTokenOptions<TAccount>,
): Promise<RefreshAccessTokenResult<TAccount>> {
    const { store, provider, ref, force, lockPath } = options
    const skewMs = options.skewMs ?? DEFAULT_SKEW_MS

    if (!store.activeBundle) {
        throw new CliError(
            'AUTH_REFRESH_UNAVAILABLE',
            'TokenStore does not implement activeBundle; refresh is not supported.',
            { hints: ['Re-run the login command to reauthorize.'] },
        )
    }

    const snapshot = await store.activeBundle(ref)
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
    if (!provider.refreshToken) {
        throw new CliError(
            'AUTH_REFRESH_UNAVAILABLE',
            'Auth provider does not implement refreshToken.',
        )
    }

    const lock = await acquireLock(lockPath, store, ref, snapshot)
    if (lock.kind === 'rotated-by-holder') {
        return { rotated: true, bundle: lock.snapshot.bundle, account: lock.snapshot.account }
    }
    if (lock.kind === 'timeout') {
        throw new CliError(
            'AUTH_REFRESH_TRANSIENT',
            'Timed out waiting for a concurrent refresh to complete.',
            { hints: ['Try again.'] },
        )
    }

    try {
        const exchange = await provider.refreshToken({
            refreshToken: snapshot.bundle.refreshToken,
            handshake: {},
        })

        const account = exchange.account ?? snapshot.account
        const bundle = bundleFromExchange(exchange, snapshot.bundle)

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

type LockOutcome<TAccount extends AuthAccount> =
    | { kind: 'acquired' }
    | { kind: 'rotated-by-holder'; snapshot: ActiveBundleSnapshot<TAccount> }
    | { kind: 'timeout' }

/**
 * Try to acquire the `O_EXCL` lock. On `EEXIST`, poll for the lock file to
 * disappear (up to `LOCK_WAIT_TIMEOUT_MS`). Whether the wait ends via
 * acquisition, lock-released, or timeout, re-read the bundle: if the holder
 * has rotated, return the new snapshot so the waiter doesn't POST.
 */
async function acquireLock<TAccount extends AuthAccount>(
    lockPath: string,
    store: TokenStore<TAccount>,
    ref: AccountRef | undefined,
    snapshotBefore: ActiveBundleSnapshot<TAccount>,
): Promise<LockOutcome<TAccount>> {
    if (await tryCreateLockFile(lockPath)) {
        return { kind: 'acquired' }
    }

    const deadline = Date.now() + LOCK_WAIT_TIMEOUT_MS
    while (Date.now() < deadline) {
        await sleep(LOCK_POLL_INTERVAL_MS)
        if (await tryCreateLockFile(lockPath)) {
            // Lock acquired — but the holder may have completed a rotation
            // before releasing. Re-check the store before POSTing.
            const fresh = await store.activeBundle?.(ref)
            if (fresh && hasRotated(snapshotBefore.bundle, fresh.bundle)) {
                await releaseLock(lockPath)
                return { kind: 'rotated-by-holder', snapshot: fresh }
            }
            return { kind: 'acquired' }
        }
    }

    // Timed out: holder didn't release. Re-read once more — they may have
    // rotated then crashed before unlinking, in which case the waiter should
    // still benefit from the new bundle.
    const fresh = await store.activeBundle?.(ref)
    if (fresh && hasRotated(snapshotBefore.bundle, fresh.bundle)) {
        return { kind: 'rotated-by-holder', snapshot: fresh }
    }
    return { kind: 'timeout' }
}

function hasRotated(before: TokenBundle, after: TokenBundle): boolean {
    if (after.accessToken !== before.accessToken) return true
    if (after.accessTokenExpiresAt !== before.accessTokenExpiresAt) return true
    return false
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
