import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { CliError } from '../errors.js'
import { refreshAccessToken } from './refresh.js'
import type {
    ActiveBundleSnapshot,
    AuthProvider,
    ExchangeResult,
    TokenBundle,
    TokenStore,
} from './types.js'

type Account = { id: string; label?: string; email: string }

const account: Account = { id: '42', email: 'a@b' }

function bundle(overrides: Partial<TokenBundle> = {}): TokenBundle {
    return {
        accessToken: 'tok_a',
        refreshToken: 'r_a',
        accessTokenExpiresAt: Date.now() + 10_000,
        ...overrides,
    }
}

type StoreState = {
    snapshot: ActiveBundleSnapshot<Account> | null
    activeBundleSpy: ReturnType<typeof vi.fn>
    setBundleSpy: ReturnType<typeof vi.fn>
    setBundleCalls: { account: Account; bundle: TokenBundle; options?: unknown }[]
}

function fakeStore(
    initial: ActiveBundleSnapshot<Account> | null,
    overrides: Partial<TokenStore<Account>> = {},
): { store: TokenStore<Account>; state: StoreState } {
    const setBundleCalls: StoreState['setBundleCalls'] = []
    const state: StoreState = {
        snapshot: initial,
        activeBundleSpy: vi.fn(),
        setBundleSpy: vi.fn(),
        setBundleCalls,
    }
    state.activeBundleSpy.mockImplementation(async () => state.snapshot)
    state.setBundleSpy.mockImplementation(
        async (acc: Account, b: TokenBundle, options?: unknown) => {
            setBundleCalls.push({ account: acc, bundle: b, options })
            state.snapshot = { account: acc, bundle: b }
        },
    )
    const store: TokenStore<Account> = {
        async active() {
            return state.snapshot
                ? { token: state.snapshot.bundle.accessToken, account: state.snapshot.account }
                : null
        },
        activeBundle: state.activeBundleSpy as unknown as TokenStore<Account>['activeBundle'],
        async set() {},
        setBundle: state.setBundleSpy as unknown as TokenStore<Account>['setBundle'],
        async clear() {},
        async list() {
            return []
        },
        async setDefault() {},
        ...overrides,
    }
    return { store, state }
}

function fakeProvider(
    refreshImpl?: (input: { refreshToken: string }) => Promise<ExchangeResult<Account>>,
): { provider: AuthProvider<Account>; refreshSpy: ReturnType<typeof vi.fn> } {
    const refreshSpy = vi.fn(
        refreshImpl ??
            (async () => ({
                accessToken: 'tok_new',
                refreshToken: 'r_new',
                expiresAt: Date.now() + 60_000,
            })),
    )
    const provider: AuthProvider<Account> = {
        async authorize() {
            return { authorizeUrl: '', handshake: {} }
        },
        async exchangeCode() {
            return { accessToken: '' }
        },
        async validateToken() {
            return account
        },
        refreshToken: refreshSpy as unknown as AuthProvider<Account>['refreshToken'],
    }
    return { provider, refreshSpy }
}

describe('refreshAccessToken', () => {
    let lockDir: string
    let lockPath: string

    beforeEach(async () => {
        lockDir = await mkdtemp(join(tmpdir(), 'cli-core-refresh-'))
        lockPath = join(lockDir, 'refresh.lock')
    })

    afterEach(async () => {
        await rm(lockDir, { recursive: true, force: true })
    })

    it('rotates the bundle when access expiry is inside the skew window', async () => {
        const { store, state } = fakeStore({
            account,
            bundle: bundle({ accessTokenExpiresAt: Date.now() + 1_000 }),
        })
        const { provider, refreshSpy } = fakeProvider()

        const result = await refreshAccessToken({
            store,
            provider,
            skewMs: 5_000,
            lockPath,
        })

        expect(result.rotated).toBe(true)
        expect(result.bundle.accessToken).toBe('tok_new')
        expect(refreshSpy).toHaveBeenCalledWith({ refreshToken: 'r_a', handshake: {} })
        // promoteDefault omitted (not just `false`): a silent rotation must
        // not re-pin selection, and the helper distinguishes "absent" from
        // "explicit opt-out" via arg count.
        expect(state.setBundleCalls).toHaveLength(1)
        expect(state.setBundleCalls[0].options).toBeUndefined()
    })

    it('returns rotated:false without POSTing when access expiry is outside the skew window', async () => {
        const { store } = fakeStore({
            account,
            bundle: bundle({ accessTokenExpiresAt: Date.now() + 60_000 }),
        })
        const { provider, refreshSpy } = fakeProvider()

        const result = await refreshAccessToken({
            store,
            provider,
            skewMs: 5_000,
            lockPath,
        })

        expect(result.rotated).toBe(false)
        expect(refreshSpy).not.toHaveBeenCalled()
    })

    it('force:true rotates regardless of expiry', async () => {
        const { store } = fakeStore({
            account,
            bundle: bundle({ accessTokenExpiresAt: Date.now() + 60_000 }),
        })
        const { provider, refreshSpy } = fakeProvider()

        const result = await refreshAccessToken({
            store,
            provider,
            force: true,
            lockPath,
        })

        expect(result.rotated).toBe(true)
        expect(refreshSpy).toHaveBeenCalledTimes(1)
    })

    it('returns rotated:false when accessTokenExpiresAt is missing (consumer reactive-refreshes on 401)', async () => {
        const { store } = fakeStore({
            account,
            bundle: { accessToken: 'tok_a', refreshToken: 'r_a' },
        })
        const { provider, refreshSpy } = fakeProvider()

        const result = await refreshAccessToken({ store, provider, lockPath })

        expect(result.rotated).toBe(false)
        expect(refreshSpy).not.toHaveBeenCalled()
    })

    it('throws AUTH_REFRESH_UNAVAILABLE when the bundle has no refresh token', async () => {
        const { store } = fakeStore({
            account,
            bundle: { accessToken: 'tok_a', accessTokenExpiresAt: Date.now() + 1_000 },
        })
        const { provider } = fakeProvider()

        await expect(
            refreshAccessToken({ store, provider, skewMs: 5_000, lockPath }),
        ).rejects.toMatchObject({ code: 'AUTH_REFRESH_UNAVAILABLE' })
    })

    it('throws AUTH_REFRESH_UNAVAILABLE when the store has no snapshot', async () => {
        const { store } = fakeStore(null)
        const { provider } = fakeProvider()

        await expect(
            refreshAccessToken({ store, provider, force: true, lockPath }),
        ).rejects.toMatchObject({ code: 'AUTH_REFRESH_UNAVAILABLE' })
    })

    it('throws AUTH_REFRESH_UNAVAILABLE when the provider does not implement refreshToken', async () => {
        const { store } = fakeStore({ account, bundle: bundle() })
        const provider: AuthProvider<Account> = {
            async authorize() {
                return { authorizeUrl: '', handshake: {} }
            },
            async exchangeCode() {
                return { accessToken: '' }
            },
            async validateToken() {
                return account
            },
        }

        await expect(
            refreshAccessToken({ store, provider, force: true, lockPath }),
        ).rejects.toMatchObject({ code: 'AUTH_REFRESH_UNAVAILABLE' })
    })

    it('throws AUTH_REFRESH_UNAVAILABLE when the store does not implement activeBundle', async () => {
        const store: TokenStore<Account> = {
            async active() {
                return { token: 'tok_a', account }
            },
            async set() {},
            async clear() {},
            async list() {
                return []
            },
            async setDefault() {},
        }
        const { provider } = fakeProvider()

        await expect(
            refreshAccessToken({ store, provider, force: true, lockPath }),
        ).rejects.toMatchObject({ code: 'AUTH_REFRESH_UNAVAILABLE' })
    })

    it('lock contention: returns the rotated bundle when the holder rotated during the wait', async () => {
        // Pre-create the lock file to simulate a holder.
        await writeFile(lockPath, '', { flag: 'wx' })

        const initial: ActiveBundleSnapshot<Account> = {
            account,
            bundle: bundle({ accessTokenExpiresAt: Date.now() + 1_000 }),
        }
        const { store, state } = fakeStore(initial)
        const { provider, refreshSpy } = fakeProvider()

        // Simulate the holder rotating then releasing the lock, awaited
        // alongside the call so no background task outlives the test.
        const holder = (async () => {
            await sleep(120)
            state.snapshot = {
                account,
                bundle: { accessToken: 'tok_held', refreshToken: 'r_held' },
            }
            await rm(lockPath, { force: true })
        })()

        const [result] = await Promise.all([
            refreshAccessToken({ store, provider, skewMs: 5_000, lockPath }),
            holder,
        ])

        expect(result.rotated).toBe(true)
        expect(result.bundle.accessToken).toBe('tok_held')
        // Waiter must not have POSTed — the holder already did.
        expect(refreshSpy).not.toHaveBeenCalled()
    })

    it('lock contention: throws AUTH_REFRESH_TRANSIENT when the holder times out without rotating', async () => {
        await writeFile(lockPath, '', { flag: 'wx' })

        const { store } = fakeStore({
            account,
            bundle: bundle({ accessTokenExpiresAt: Date.now() + 1_000 }),
        })
        const { provider, refreshSpy } = fakeProvider()

        await expect(
            refreshAccessToken({ store, provider, skewMs: 5_000, lockPath }),
        ).rejects.toMatchObject({ code: 'AUTH_REFRESH_TRANSIENT' })
        expect(refreshSpy).not.toHaveBeenCalled()
    }, 5_000)

    it('carries the previous refresh token forward when the server omits it from the response', async () => {
        const { store, state } = fakeStore({
            account,
            bundle: bundle({
                refreshToken: 'r_existing',
                accessTokenExpiresAt: Date.now() + 1_000,
                refreshTokenExpiresAt: 9_999_999_999_999,
            }),
        })
        const { provider } = fakeProvider(async () => ({
            accessToken: 'tok_new',
            expiresAt: Date.now() + 60_000,
        }))

        const result = await refreshAccessToken({
            store,
            provider,
            force: true,
            lockPath,
        })

        expect(result.bundle.refreshToken).toBe('r_existing')
        expect(result.bundle.refreshTokenExpiresAt).toBe(9_999_999_999_999)
        expect(state.setBundleCalls[0].bundle.refreshToken).toBe('r_existing')
    })

    it('throws AUTH_REFRESH_UNAVAILABLE when the store implements activeBundle but not setBundle', async () => {
        // A store that can read the bundle but not persist a full one would
        // silently drop the rotated refresh token — refuse instead.
        const { store } = fakeStore({ account, bundle: bundle() }, { setBundle: undefined })
        const { provider } = fakeProvider()

        await expect(
            refreshAccessToken({ store, provider, force: true, lockPath }),
        ).rejects.toMatchObject({ code: 'AUTH_REFRESH_UNAVAILABLE' })
    })

    it('releases the lock after a failed refresh so a retry can proceed', async () => {
        const { store } = fakeStore({
            account,
            bundle: bundle({ accessTokenExpiresAt: Date.now() + 1_000 }),
        })
        const { provider } = fakeProvider(async () => {
            throw new CliError('AUTH_REFRESH_EXPIRED', 'rejected by server')
        })

        await expect(
            refreshAccessToken({ store, provider, skewMs: 5_000, lockPath }),
        ).rejects.toMatchObject({ code: 'AUTH_REFRESH_EXPIRED' })

        // The `finally` released the O_EXCL lock — no orphan left to block retries.
        await expect(stat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' })
    })
})
