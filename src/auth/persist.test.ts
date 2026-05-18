import { describe, expect, it } from 'vitest'

import { bundleFromExchange, persistBundle } from './persist.js'
import type { AuthAccount, TokenBundle, TokenStore } from './types.js'

type Account = AuthAccount & { email: string }
const account: Account = { id: '1', email: 'a@b' }

/**
 * Minimal in-memory store. The `setBundle` slot is optional so tests can
 * exercise both the modern (bundle-aware) path and the legacy
 * (`set`-only) fallback.
 */
function buildStore(opts: { withSetBundle: boolean }): TokenStore<Account> & {
    setCalls: Array<{ token: string }>
    setBundleCalls: Array<{ bundle: TokenBundle; promoteDefault: boolean | undefined }>
} {
    const setCalls: Array<{ token: string }> = []
    const setBundleCalls: Array<{ bundle: TokenBundle; promoteDefault: boolean | undefined }> = []
    const store: TokenStore<Account> = {
        async active() {
            return null
        },
        async set(_account, token) {
            setCalls.push({ token })
        },
        async clear() {},
        async list() {
            return []
        },
        async setDefault() {},
    }
    if (opts.withSetBundle) {
        store.setBundle = async (_account, bundle, setOptions) => {
            setBundleCalls.push({ bundle, promoteDefault: setOptions?.promoteDefault })
        }
    }
    return Object.assign(store, { setCalls, setBundleCalls })
}

describe('persistBundle', () => {
    it('calls setBundle with the full bundle when the store implements it', async () => {
        const store = buildStore({ withSetBundle: true })
        const bundle: TokenBundle = {
            accessToken: 'at-1',
            refreshToken: 'rt-1',
            accessTokenExpiresAt: 100,
        }

        await persistBundle(store, account, bundle)

        expect(store.setBundleCalls).toHaveLength(1)
        expect(store.setBundleCalls[0].bundle).toEqual(bundle)
        expect(store.setCalls).toHaveLength(0)
    })

    it('threads promoteDefault: true through to setBundle (explicit login path)', async () => {
        const store = buildStore({ withSetBundle: true })

        await persistBundle(store, account, { accessToken: 'at' }, { promoteDefault: true })

        expect(store.setBundleCalls[0].promoteDefault).toBe(true)
    })

    it('passes promoteDefault: undefined to setBundle when omitted (silent refresh path)', async () => {
        // Silent refresh must NOT promote default. The shared helper
        // forwards the missing flag as `undefined`; downstream stores must
        // treat `undefined` and `false` identically.
        const store = buildStore({ withSetBundle: true })

        await persistBundle(store, account, { accessToken: 'at' })

        expect(store.setBundleCalls[0].promoteDefault).toBeUndefined()
    })

    it('falls back to set(token) when the store omits setBundle (legacy single-token store)', async () => {
        // Compatibility floor for custom stores predating refresh-token
        // support. Refresh + expiry metadata is intentionally dropped —
        // single-token stores can't persist them.
        const store = buildStore({ withSetBundle: false })

        await persistBundle(store, account, {
            accessToken: 'at-fallback',
            refreshToken: 'rt-dropped',
            accessTokenExpiresAt: 999,
        })

        expect(store.setCalls).toEqual([{ token: 'at-fallback' }])
        expect(store.setBundleCalls).toHaveLength(0)
    })
})

describe('bundleFromExchange', () => {
    it('maps the access token + access expiry + refresh from the exchange', async () => {
        const expiresAt = Date.now() + 3_600_000
        const bundle = bundleFromExchange({
            accessToken: 'at-1',
            refreshToken: 'rt-1',
            expiresAt,
        })

        expect(bundle).toEqual({
            accessToken: 'at-1',
            refreshToken: 'rt-1',
            accessTokenExpiresAt: expiresAt,
            refreshTokenExpiresAt: undefined,
        })
    })

    it('carries forward previous refresh token when the exchange omits one (rotation off)', async () => {
        // Some OAuth servers don't rotate refresh tokens. The helper must
        // preserve the stored refresh through subsequent refresh exchanges
        // — otherwise the next refresh would have no refresh_token to
        // POST and surface as AUTH_REFRESH_UNAVAILABLE.
        const previous: TokenBundle = {
            accessToken: 'old',
            refreshToken: 'keep-me',
            refreshTokenExpiresAt: 12345,
        }
        const bundle = bundleFromExchange({ accessToken: 'new-at', expiresAt: 999 }, previous)

        expect(bundle.refreshToken).toBe('keep-me')
        expect(bundle.refreshTokenExpiresAt).toBe(12345)
    })

    it('honours a fresh refresh token from the exchange over the previous one (rotation on)', async () => {
        const previous: TokenBundle = { accessToken: 'old', refreshToken: 'old-rt' }
        const bundle = bundleFromExchange({ accessToken: 'new', refreshToken: 'new-rt' }, previous)

        expect(bundle.refreshToken).toBe('new-rt')
    })
})
