import { describe, expect, it } from 'vitest'

import { CliError } from '../errors.js'
import { fakeRefreshProvider, installLockPath } from '../test-support/refresh-fixtures.js'
import { type TestAccount as Account, alanGrant, buildTokenStore } from '../testing/accounts.js'
import { refreshSnapshotOrNull } from './refresh-snapshot.js'
import type { TokenBundle } from './types.js'

const account = alanGrant

function storeWith(bundle: TokenBundle) {
    return buildTokenStore<Account>({ entries: [{ account, isDefault: true, bundle }] })
}

const expiring = (): TokenBundle => ({
    accessToken: 'tok_old',
    refreshToken: 'r_old',
    accessTokenExpiresAt: Date.now() + 1_000,
})

const expired = (): TokenBundle => ({
    accessToken: 'tok_old',
    refreshToken: 'r_old',
    accessTokenExpiresAt: Date.now() - 1_000,
})

describe('refreshSnapshotOrNull', () => {
    const lockPath = installLockPath()

    it('returns the rotated bundle when the access token is expiring', async () => {
        const { store, state } = storeWith(expiring())
        const { provider, refreshSpy } = fakeRefreshProvider()

        const result = await refreshSnapshotOrNull(store, undefined, {
            provider,
            lockPath: lockPath(),
        })

        expect(result).toMatchObject({ token: 'tok_new', account })
        expect(result?.bundle.refreshToken).toBe('r_new')
        expect(refreshSpy).toHaveBeenCalledTimes(1)
        expect(state.setBundleCalls).toHaveLength(1)
    })

    it('returns the stored bundle without POSTing when the token is fresh', async () => {
        const { store } = storeWith({ ...expiring(), accessTokenExpiresAt: Date.now() + 600_000 })
        const { provider, refreshSpy } = fakeRefreshProvider()

        const result = await refreshSnapshotOrNull(store, undefined, {
            provider,
            lockPath: lockPath(),
        })

        expect(result).toMatchObject({ token: 'tok_old', account })
        expect(refreshSpy).not.toHaveBeenCalled()
    })

    it('returns null (fall back to stored read) when there is no refresh token', async () => {
        const { store } = storeWith({ accessToken: 'tok_old', accessTokenExpiresAt: Date.now() })
        const { provider, refreshSpy } = fakeRefreshProvider()

        const result = await refreshSnapshotOrNull(store, undefined, {
            provider,
            lockPath: lockPath(),
        })

        expect(result).toBeNull()
        expect(refreshSpy).not.toHaveBeenCalled()
    })

    it('returns null when the store lacks bundle support', async () => {
        const { store } = buildTokenStore<Account>({
            entries: [{ account, isDefault: true, bundle: expiring() }],
            overrides: { activeBundle: undefined },
        })
        const { provider } = fakeRefreshProvider()

        await expect(
            refreshSnapshotOrNull(store, undefined, { provider, lockPath: lockPath() }),
        ).resolves.toBeNull()
    })

    it('returns null on an empty store so the caller reports NOT_AUTHENTICATED itself', async () => {
        const { store } = buildTokenStore<Account>({ entries: [] })
        const { provider } = fakeRefreshProvider()

        await expect(
            refreshSnapshotOrNull(store, undefined, { provider, lockPath: lockPath() }),
        ).resolves.toBeNull()
    })

    it('returns null on a transient failure while the stored token is still valid', async () => {
        const { store } = storeWith(expiring())
        const { provider } = fakeRefreshProvider(async () => {
            throw new CliError('AUTH_REFRESH_TRANSIENT', 'network down')
        })

        await expect(
            refreshSnapshotOrNull(store, undefined, { provider, lockPath: lockPath() }),
        ).resolves.toBeNull()
    })

    it('returns the stored bundle without POSTing when no expiry is tracked', async () => {
        const { store } = storeWith({ accessToken: 'tok_old', refreshToken: 'r_old' })
        const { provider, refreshSpy } = fakeRefreshProvider()

        // Without an expiry there is nothing to refresh proactively against;
        // the consumer's reactive 401 path stays authoritative.
        await expect(
            refreshSnapshotOrNull(store, undefined, { provider, lockPath: lockPath() }),
        ).resolves.toMatchObject({ token: 'tok_old' })
        expect(refreshSpy).not.toHaveBeenCalled()
    })

    it('rethrows a transient failure when the stored token has already expired', async () => {
        const { store } = storeWith(expired())
        const thrown = new CliError('AUTH_REFRESH_TRANSIENT', 'network down')
        const { provider } = fakeRefreshProvider(async () => {
            throw thrown
        })

        await expect(
            refreshSnapshotOrNull(store, undefined, { provider, lockPath: lockPath() }),
        ).rejects.toBe(thrown)
    })

    it('rethrows AUTH_REFRESH_EXPIRED even while the stored token is still valid', async () => {
        const { store } = storeWith(expiring())
        const thrown = new CliError('AUTH_REFRESH_EXPIRED', 'invalid_grant')
        const { provider } = fakeRefreshProvider(async () => {
            throw thrown
        })

        await expect(
            refreshSnapshotOrNull(store, undefined, { provider, lockPath: lockPath() }),
        ).rejects.toBe(thrown)
    })

    it('propagates AUTH_STORE_READ_FAILED from the bundle read', async () => {
        const thrown = new CliError('AUTH_STORE_READ_FAILED', 'keyring offline')
        const { store } = buildTokenStore<Account>({
            entries: [{ account, isDefault: true, bundle: expiring() }],
            overrides: { activeBundle: async () => Promise.reject(thrown) },
        })
        const { provider } = fakeRefreshProvider()

        await expect(
            refreshSnapshotOrNull(store, undefined, { provider, lockPath: lockPath() }),
        ).rejects.toBe(thrown)
    })

    it('propagates non-CliError failures from the provider', async () => {
        const { store } = storeWith(expiring())
        const thrown = new TypeError('boom')
        const { provider } = fakeRefreshProvider(async () => {
            throw thrown
        })

        await expect(
            refreshSnapshotOrNull(store, undefined, { provider, lockPath: lockPath() }),
        ).rejects.toBe(thrown)
    })

    it('threads ref into the refresh so --user targets the right account', async () => {
        const { store } = storeWith(expiring())
        const { provider } = fakeRefreshProvider()

        await expect(
            refreshSnapshotOrNull(store, 'ghost', { provider, lockPath: lockPath() }),
        ).resolves.toBeNull()
        await expect(
            refreshSnapshotOrNull(store, 'alan@ingen.com', { provider, lockPath: lockPath() }),
        ).resolves.toMatchObject({ token: 'tok_new' })
    })
})
