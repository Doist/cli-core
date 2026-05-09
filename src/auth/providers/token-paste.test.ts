import { describe, expect, it, vi } from 'vitest'

import { createTokenPasteProvider } from './token-paste.js'

type Account = { id: string; label?: string }

describe('createTokenPasteProvider', () => {
    it('routes acceptPastedToken to validate', async () => {
        const validate = vi.fn(async ({ token }) => ({ id: '1', label: token }))
        const provider = createTokenPasteProvider<Account>({ validate })

        const account = await provider.acceptPastedToken?.({ token: 'tok', flags: { x: 1 } })
        expect(account).toEqual({ id: '1', label: 'tok' })
        expect(validate).toHaveBeenCalledWith({ token: 'tok', flags: { x: 1 } })
    })

    it('validateToken delegates to validate without flags', async () => {
        const validate = vi.fn(async ({ token }) => ({ id: '1', label: token }))
        const provider = createTokenPasteProvider<Account>({ validate })
        await provider.validateToken({ token: 'tok', handshake: {} })
        expect(validate).toHaveBeenCalledWith({ token: 'tok', flags: {} })
    })

    it('authorize and exchangeCode throw AUTH_PROVIDER_UNSUPPORTED', async () => {
        const provider = createTokenPasteProvider<Account>({
            validate: async () => ({ id: '1' }),
        })
        await expect(
            provider.authorize({
                redirectUri: '',
                state: '',
                scopes: [],
                readOnly: false,
                flags: {},
                handshake: {},
            }),
        ).rejects.toMatchObject({ code: 'AUTH_PROVIDER_UNSUPPORTED' })
        await expect(
            provider.exchangeCode({
                code: '',
                state: '',
                redirectUri: '',
                handshake: {},
            }),
        ).rejects.toMatchObject({ code: 'AUTH_PROVIDER_UNSUPPORTED' })
    })
})
