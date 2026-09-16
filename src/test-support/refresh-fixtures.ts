import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, vi } from 'vitest'

import type { AuthProvider, ExchangeResult } from '../auth/types.js'
import type { TestAccount } from '../testing/accounts.js'

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

export const ROTATED: ExchangeResult<TestAccount> = {
    accessToken: 'tok_new',
    refreshToken: 'r_new',
    expiresAt: Date.now() + 60_000,
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
            throw new Error('validateToken is not exercised by refresh fixtures')
        },
        refreshToken: refreshSpy as unknown as AuthProvider<TestAccount>['refreshToken'],
    }
    return { provider, refreshSpy }
}
