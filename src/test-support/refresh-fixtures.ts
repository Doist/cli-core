import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, vi } from 'vitest'

import type { AuthProvider, ExchangeResult, TokenBundle } from '../auth/types.js'
import {
    type TestAccount,
    type TokenStoreHarness,
    alanGrant,
    buildTokenStore,
} from '../testing/accounts.js'

// Shared refresh scaffolding for the suites that exercise the opt-in `refresh`
// path on the read-only attachers (`token` / `status`) and the fallback helper
// behind them. Internal-only (under `src/test-support/`, excluded from the
// build).

/**
 * Per-test O_EXCL lock path under a fresh tmpdir, so parallel suites never
 * contend on one lock file. Returns a getter valid inside each test.
 */
export function installLockPath(): () => string {
    let lockDir: string
    let lockPath: string
    beforeEach(async () => {
        lockDir = await mkdtemp(join(tmpdir(), 'cli-core-refresh-'))
        lockPath = join(lockDir, 'refresh.lock')
    })
    afterEach(async () => {
        await rm(lockDir, { recursive: true, force: true })
    })
    return () => lockPath
}

const ROTATED: ExchangeResult<TestAccount> = {
    accessToken: 'tok_new',
    refreshToken: 'r_new',
    expiresAt: Date.now() + 60_000,
}

/**
 * Bundle inside the default 60s skew window but with plenty of wall-clock
 * headroom, so a test that expects "still valid" can't flip on a slow CI box.
 */
export function expiringBundle(overrides: Partial<TokenBundle> = {}): TokenBundle {
    return {
        accessToken: 'tok_old',
        refreshToken: 'r_old',
        accessTokenExpiresAt: Date.now() + 30_000,
        ...overrides,
    }
}

export function expiredBundle(overrides: Partial<TokenBundle> = {}): TokenBundle {
    return expiringBundle({ accessTokenExpiresAt: Date.now() - 30_000, ...overrides })
}

/** Single-account, bundle-capable store seeded with `bundle` for `alanGrant`. */
export function buildBundleStore(bundle: TokenBundle): TokenStoreHarness<TestAccount> {
    return buildTokenStore<TestAccount>({
        entries: [{ account: alanGrant, isDefault: true, bundle }],
    })
}

/**
 * Minimal `AuthProvider` whose `refreshToken` is a spy. Defaults to resolving
 * `ROTATED`; pass `refreshImpl` to reject with a typed refresh error.
 */
export function fakeRefreshProvider(refreshImpl?: AuthProvider<TestAccount>['refreshToken']): {
    provider: AuthProvider<TestAccount>
    refreshSpy: ReturnType<typeof vi.fn>
} {
    const refreshSpy = vi.fn(refreshImpl ?? (async () => ROTATED))
    const provider: AuthProvider<TestAccount> = {
        async authorize() {
            return { authorizeUrl: '', handshake: {} }
        },
        async exchangeCode() {
            return { accessToken: '' }
        },
        async validateToken() {
            return alanGrant
        },
        refreshToken: refreshSpy as unknown as AuthProvider<TestAccount>['refreshToken'],
    }
    return { provider, refreshSpy }
}
