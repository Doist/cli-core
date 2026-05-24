import { describe, expect, it, vi } from 'vitest'

import { CliError } from '../errors.js'
import { type TestAccount as Account, buildTokenStore, ianMalcolm } from '../testing/accounts.js'
import { persistBundle } from './persist.js'
import type { TokenBundle, TokenStore } from './types.js'

const account = ianMalcolm
const bundle: TokenBundle = {
    accessToken: 'tok_access',
    refreshToken: 'tok_refresh',
    accessTokenExpiresAt: 1_700_000_000_000,
}

// Default to a store that implements neither bundle method, so persistBundle's
// fallback path is the baseline; tests opt into `setBundle`/`set` via overrides.
function fakeStore(overrides: Partial<TokenStore<Account>> = {}): TokenStore<Account> {
    return buildTokenStore({
        overrides: { setBundle: undefined, activeBundle: undefined, ...overrides },
    }).store
}

describe('persistBundle', () => {
    it('prefers setBundle when the store implements it', async () => {
        const setBundle = vi.fn(async () => undefined)
        const set = vi.fn(async () => undefined)
        const store = fakeStore({ setBundle, set })

        await persistBundle({ store, account, bundle, promoteDefault: true })

        expect(setBundle).toHaveBeenCalledWith(account, bundle, { promoteDefault: true })
        expect(set).not.toHaveBeenCalled()
    })

    it('falls back to set(accessToken) when the store does not implement setBundle', async () => {
        const set = vi.fn(async () => undefined)
        const store = fakeStore({ set })

        await persistBundle({ store, account, bundle, promoteDefault: true })

        expect(set).toHaveBeenCalledWith(account, 'tok_access')
    })

    it('omits the options argument entirely when promoteDefault is unset', async () => {
        const setBundle = vi.fn(async () => undefined)
        const store = fakeStore({ setBundle })

        await persistBundle({ store, account, bundle })

        // Presence-based handling: callers must be able to distinguish
        // "default behaviour" from explicit opt-out via arg count.
        expect(setBundle).toHaveBeenCalledTimes(1)
        expect(setBundle.mock.calls[0]).toEqual([account, bundle])
    })

    it('rethrows CliError without wrapping', async () => {
        const cause = new CliError('AUTH_STORE_WRITE_FAILED', 'boom')
        const store = fakeStore({
            setBundle: vi.fn(async () => {
                throw cause
            }),
        })

        await expect(persistBundle({ store, account, bundle })).rejects.toBe(cause)
    })

    it('wraps non-CliError failures as AUTH_STORE_WRITE_FAILED', async () => {
        const store = fakeStore({
            setBundle: vi.fn(async () => {
                throw new Error('disk full')
            }),
        })

        await expect(persistBundle({ store, account, bundle })).rejects.toMatchObject({
            code: 'AUTH_STORE_WRITE_FAILED',
        })
    })
})
