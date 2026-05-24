import { describe, expect, expectTypeOf, it } from 'vitest'

import type { AuthAccount, TokenStore } from '../auth/types.js'
import { buildTokenStore } from './accounts.js'

// A consumer-style account with no `email` (mirrors TwistAccount) — proves the
// generic store mock type-checks and works for account shapes beyond the
// default `TestAccount`, standing in for a real consumer without importing one.
type NoEmailAccount = AuthAccount & { authMode: string; authScope: string }

describe('buildTokenStore generic reuse', () => {
    it('serves a no-email account and honours a custom matchAccount', async () => {
        const alan: NoEmailAccount = { id: '1', label: 'Alan', authMode: 'rw', authScope: 's' }
        const { store } = buildTokenStore<NoEmailAccount>({
            entries: [{ account: alan, isDefault: true }],
            matchAccount: (account, ref) => account.id === ref,
        })

        expectTypeOf(store).toEqualTypeOf<TokenStore<NoEmailAccount>>()
        await expect(store.active('1')).resolves.toEqual({ token: 'token-1', account: alan })
        // The default id/email/label matcher is overridden, so a label ref no longer resolves.
        await expect(store.active('Alan')).resolves.toBeNull()
    })
})
