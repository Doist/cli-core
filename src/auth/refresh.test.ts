import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { refreshAccessToken } from './refresh.js'
import type { AuthProvider, TokenBundle, TokenStore } from './types.js'

type Account = { id: string; label?: string; email: string }
const account: Account = { id: '1', label: 'a', email: 'a@b' }

function buildStore(initial: TokenBundle | null) {
    const state: { bundle: TokenBundle | null; setCalls: TokenBundle[] } = {
        bundle: initial,
        setCalls: [],
    }
    const store: TokenStore<Account> = {
        async active() {
            return state.bundle
                ? { token: state.bundle.accessToken, bundle: state.bundle, account }
                : null
        },
        async set(_account, token) {
            const bundle = { accessToken: token }
            state.bundle = bundle
            state.setCalls.push(bundle)
        },
        async setBundle(_account, bundle) {
            state.bundle = bundle
            state.setCalls.push(bundle)
        },
        async clear() {
            state.bundle = null
        },
        async list() {
            return state.bundle ? [{ account, isDefault: true }] : []
        },
        async setDefault() {},
    }
    return { store, state }
}

function refreshingProvider(
    impl?: (input: {
        refreshToken: string
        account: Account
    }) => Promise<{ accessToken: string; refreshToken?: string; expiresAt?: number }>,
): AuthProvider<Account> & { refreshSpy: ReturnType<typeof vi.fn> } {
    const refreshSpy = vi.fn(
        impl ??
            (async () => ({
                accessToken: 'new-access',
                refreshToken: 'new-refresh',
                expiresAt: Date.now() + 3_600_000,
            })),
    )
    const provider: AuthProvider<Account> = {
        async authorize() {
            return { authorizeUrl: '', handshake: {} }
        },
        async exchangeCode() {
            return { accessToken: 'x' }
        },
        async validateToken() {
            return account
        },
        refreshToken: async (input) => ({ ...(await refreshSpy(input)), account: input.account }),
    }
    return Object.assign(provider, { refreshSpy })
}

describe('refreshAccessToken', () => {
    let tempDir: string
    let lockPath: string

    beforeEach(() => {
        tempDir = mkdtempSync(join(tmpdir(), 'cli-core-refresh-'))
        lockPath = join(tempDir, 'refresh.lock')
    })
    afterEach(() => {
        rmSync(tempDir, { recursive: true, force: true })
    })

    it('returns the active snapshot unchanged when the access token is well within its skew window', async () => {
        const { store, state } = buildStore({
            accessToken: 'still-good',
            refreshToken: 'rt',
            accessTokenExpiresAt: Date.now() + 600_000,
        })
        const provider = refreshingProvider()

        const result = await refreshAccessToken({ store, provider, lockPath })

        expect(result.token).toBe('still-good')
        expect(provider.refreshSpy).not.toHaveBeenCalled()
        expect(state.setCalls).toHaveLength(0)
    })

    it('refreshes when access token is past the skew window and persists the new bundle', async () => {
        const { store, state } = buildStore({
            accessToken: 'expired',
            refreshToken: 'rt-old',
            accessTokenExpiresAt: Date.now() - 1000,
        })
        const provider = refreshingProvider()

        const result = await refreshAccessToken({ store, provider, lockPath })

        expect(provider.refreshSpy).toHaveBeenCalledWith(
            expect.objectContaining({ refreshToken: 'rt-old', account }),
        )
        expect(result.token).toBe('new-access')
        expect(state.bundle?.refreshToken).toBe('new-refresh')
    })

    it('forces a refresh regardless of expiry when force: true (reactive 401 path)', async () => {
        const { store, state } = buildStore({
            accessToken: 'rejected-by-server',
            refreshToken: 'rt',
            accessTokenExpiresAt: Date.now() + 600_000,
        })
        const provider = refreshingProvider()

        const result = await refreshAccessToken({ store, provider, force: true, lockPath })

        expect(provider.refreshSpy).toHaveBeenCalledTimes(1)
        expect(result.token).toBe('new-access')
        expect(state.setCalls).toHaveLength(1)
    })

    it('throws AUTH_REFRESH_UNAVAILABLE when no refresh token is stored', async () => {
        const { store } = buildStore({
            accessToken: 'expired',
            accessTokenExpiresAt: Date.now() - 1000,
        })
        const provider = refreshingProvider()

        await expect(refreshAccessToken({ store, provider, lockPath })).rejects.toMatchObject({
            code: 'AUTH_REFRESH_UNAVAILABLE',
        })
    })

    it('throws AUTH_REFRESH_UNAVAILABLE when the provider does not implement refreshToken', async () => {
        const { store } = buildStore({
            accessToken: 'expired',
            refreshToken: 'rt',
            accessTokenExpiresAt: Date.now() - 1000,
        })
        const refreshlessProvider: AuthProvider<Account> = {
            authorize: async () => ({ authorizeUrl: '', handshake: {} }),
            exchangeCode: async () => ({ accessToken: 'x' }),
            validateToken: async () => account,
        }

        await expect(
            refreshAccessToken({ store, provider: refreshlessProvider, lockPath }),
        ).rejects.toMatchObject({ code: 'AUTH_REFRESH_UNAVAILABLE' })
    })

    it('throws NOT_AUTHENTICATED when the store has no active snapshot', async () => {
        const { store } = buildStore(null)
        const provider = refreshingProvider()

        await expect(refreshAccessToken({ store, provider, lockPath })).rejects.toMatchObject({
            code: 'NOT_AUTHENTICATED',
        })
    })

    it('keeps the old refresh token when the server response omits a new one', async () => {
        const { store, state } = buildStore({
            accessToken: 'expired',
            refreshToken: 'keep-me',
            accessTokenExpiresAt: Date.now() - 1000,
        })
        const provider = refreshingProvider(async () => ({
            accessToken: 'new-access',
            expiresAt: Date.now() + 3_600_000,
        }))

        await refreshAccessToken({ store, provider, lockPath })

        expect(state.bundle?.refreshToken).toBe('keep-me')
    })

    it('re-reads inside the lock and returns the fresh snapshot when another process already refreshed (force: true)', async () => {
        // Simulate two concurrent processes: this test plays the role of the
        // *losing* one. Process A has already rotated the token before we
        // acquire the lock, so the stored access token differs from what we
        // first read. Honoring `force` here would POST with our now-stale
        // refresh token and get `invalid_grant`. The helper must instead
        // return the fresh snapshot without firing its own refresh.
        const { store, state } = buildStore({
            accessToken: 'old-token',
            refreshToken: 'rt-A',
            accessTokenExpiresAt: Date.now() + 600_000,
        })
        const provider = refreshingProvider()

        // Race emulation: as soon as `active()` returns the first time, swap
        // the stored bundle to mimic Process A's win. The lock acquisition
        // then re-reads and sees the rotated token.
        const realActive = store.active.bind(store)
        let firstRead = true
        store.active = async (ref) => {
            const snapshot = await realActive(ref)
            if (firstRead) {
                firstRead = false
                state.bundle = {
                    accessToken: 'rotated-by-A',
                    refreshToken: 'rt-A-rotated',
                    accessTokenExpiresAt: Date.now() + 3_600_000,
                }
            }
            return snapshot
        }

        const result = await refreshAccessToken({ store, provider, force: true, lockPath })

        // The losing process must NOT call refresh — that's the whole point.
        expect(provider.refreshSpy).not.toHaveBeenCalled()
        expect(result.token).toBe('rotated-by-A')
        expect(result.bundle.refreshToken).toBe('rt-A-rotated')
    })

    it('skips its own refresh when another process refreshed enough headroom into the future (non-force)', async () => {
        // Lock contention path: we ARE past skew but another process beats us
        // to it. The re-read shows the fresh access token has plenty of life
        // left, so we return early without POSTing.
        const initial: TokenBundle = {
            accessToken: 'expired',
            refreshToken: 'rt',
            accessTokenExpiresAt: Date.now() - 1000,
        }
        const { store, state } = buildStore(initial)
        const provider = refreshingProvider()

        // Pre-create the lock file to simulate the other process holding it
        // briefly. We don't actually need to hold it — the timing-sensitive
        // assertion is the re-read after the lock check, which sees the
        // rotated state below.
        writeFileSync(lockPath, '')

        const realActive = store.active.bind(store)
        let firstRead = true
        store.active = async (ref) => {
            if (firstRead) {
                firstRead = false
                return realActive(ref)
            }
            return {
                token: 'fresh-from-other-proc',
                bundle: {
                    accessToken: 'fresh-from-other-proc',
                    refreshToken: 'rt-rotated',
                    accessTokenExpiresAt: Date.now() + 3_600_000,
                },
                account,
            }
        }

        // Release the lock right away by removing the file so the helper can
        // acquire it (we just want the re-read path to run).
        rmSync(lockPath)

        const result = await refreshAccessToken({ store, provider, lockPath })

        expect(provider.refreshSpy).not.toHaveBeenCalled()
        expect(result.token).toBe('fresh-from-other-proc')
        expect(state.setCalls).toHaveLength(0)
    })
})
