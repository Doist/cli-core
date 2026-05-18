import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { refreshAccessToken } from './refresh.js'
import type { AuthProvider, TokenBundle, TokenStore } from './types.js'

type Account = { id: string; label?: string; email: string }
const account: Account = { id: '1', label: 'a', email: 'a@b' }

/** In-memory store that satisfies the TokenStore contract + exposes recordsLocation. */
function buildStore(initial: TokenBundle | null) {
    const state: { bundle: TokenBundle | null; setCalls: TokenBundle[] } = {
        bundle: initial,
        setCalls: [],
    }
    let recordsLocation = '/tmp/test-records'
    const store: TokenStore<Account> & { getRecordsLocation(): string } = {
        async active() {
            return state.bundle
                ? { token: state.bundle.accessToken, bundle: state.bundle, account }
                : null
        },
        async set(_account, credentials) {
            const bundle =
                typeof credentials === 'string' ? { accessToken: credentials } : credentials
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
        getRecordsLocation: () => recordsLocation,
    }
    return {
        store,
        state,
        setRecordsLocation(path: string) {
            recordsLocation = path
        },
    }
}

function refreshingProvider(
    impl?: (input: {
        refreshToken: string
        account: Account
    }) => Promise<{ accessToken: string; refreshToken?: string; accessTokenExpiresAt?: number }>,
): AuthProvider<Account> & { refreshSpy: ReturnType<typeof vi.fn> } {
    const refreshSpy = vi.fn(
        impl ??
            (async () => ({
                accessToken: 'new-access',
                refreshToken: 'new-refresh',
                accessTokenExpiresAt: Date.now() + 3_600_000,
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

    beforeEach(() => {
        tempDir = mkdtempSync(join(tmpdir(), 'cli-core-refresh-'))
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

        const result = await refreshAccessToken({ store, provider })

        expect(result.token).toBe('still-good')
        expect(provider.refreshSpy).not.toHaveBeenCalled()
        expect(state.setCalls).toHaveLength(0)
    })

    it('refreshes when access token is past the skew window and persists the new bundle', async () => {
        const { store, state, setRecordsLocation } = buildStore({
            accessToken: 'expired',
            refreshToken: 'rt-old',
            accessTokenExpiresAt: Date.now() - 1000,
        })
        setRecordsLocation(join(tempDir, 'records.json'))
        const provider = refreshingProvider()

        const result = await refreshAccessToken({ store, provider })

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
            // Expiry hasn't been hit yet — but server already 401'd.
            accessTokenExpiresAt: Date.now() + 600_000,
        })
        const provider = refreshingProvider()

        const result = await refreshAccessToken({ store, provider, force: true })

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

        await expect(refreshAccessToken({ store, provider })).rejects.toMatchObject({
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
            refreshAccessToken({ store, provider: refreshlessProvider }),
        ).rejects.toMatchObject({ code: 'AUTH_REFRESH_UNAVAILABLE' })
    })

    it('throws NOT_AUTHENTICATED when the store has no active snapshot', async () => {
        const { store } = buildStore(null)
        const provider = refreshingProvider()

        await expect(refreshAccessToken({ store, provider })).rejects.toMatchObject({
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
            // no refresh_token in response — preserve the stored one
            accessTokenExpiresAt: Date.now() + 3_600_000,
        }))

        await refreshAccessToken({ store, provider })

        expect(state.bundle?.refreshToken).toBe('keep-me')
    })
})
