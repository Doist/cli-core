import { vi } from 'vitest'

import type {
    AccountRef,
    ActiveBundleSnapshot,
    AuthAccount,
    ClearedAccount,
    TokenBundle,
    TokenStore,
} from '../auth/types.js'
import { CliError } from '../errors.js'

// Shared account fixtures + a canonical in-memory `TokenStore` mock for the
// auth test suites. Lives under `src/test-support/` so it's excluded from the
// build (per `tsconfig.build.json`) and never reaches consumers via `dist/`.

export type TestAccount = { id: string; label?: string; email: string }

export const alanGrant: TestAccount = { id: '1', label: 'Alan Grant', email: 'alan@ingen.com' }
export const ellieSattler: TestAccount = {
    id: '2',
    label: 'Ellie Sattler',
    email: 'ellie@ingen.com',
}
export const ianMalcolm: TestAccount = { id: '3', label: 'Ian Malcolm', email: 'ian@ingen.com' }
export const johnHammond: TestAccount = { id: '4', label: 'John Hammond', email: 'john@ingen.com' }

export type StoreEntry<TAccount extends AuthAccount = TestAccount> = {
    account: TAccount
    isDefault: boolean
    /** Access token returned by `active()`. Defaults to `bundle.accessToken` or `token-<id>`. */
    token?: string
    /** Full bundle returned by `activeBundle()`. */
    bundle?: TokenBundle
}

/** Fresh default seed: Alan (default) + Ellie. Copy so callers can mutate safely. */
function ingenEntries(): StoreEntry[] {
    return [
        { account: alanGrant, isDefault: true },
        { account: ellieSattler, isDefault: false },
    ]
}

/** Stores own the matching rule; the mock matches by id, email, or label. */
function matchesRef(account: AuthAccount, ref: string): boolean {
    return account.id === ref || account.email === ref || account.label === ref
}

export type TokenStoreHarness<TAccount extends AuthAccount> = {
    store: TokenStore<TAccount>
    activeSpy: ReturnType<typeof vi.fn>
    clearSpy: ReturnType<typeof vi.fn>
    listSpy: ReturnType<typeof vi.fn>
    setDefaultSpy: ReturnType<typeof vi.fn>
    state: {
        /** Live, mutable entry list — tests may reassign `bundle`/`token` to simulate rotation. */
        entries: StoreEntry<TAccount>[]
        setBundleCalls: { account: TAccount; bundle: TokenBundle; options?: unknown }[]
    }
}

/**
 * Canonical stateful, multi-account `TokenStore` mock. Models the full contract
 * over a mutable entry list: id/email/label matching, default re-pinning,
 * token-free removal returning `ClearedAccount`, and optional bundle read/write.
 * Pass `overrides` to replace (or delete, via `{ method: undefined }`) any
 * method for a specific scenario. Returns the store plus per-method spies and a
 * live `state`.
 */
export function buildTokenStore<TAccount extends AuthAccount = TestAccount>(
    opts: { entries?: StoreEntry<TAccount>[]; overrides?: Partial<TokenStore<TAccount>> } = {},
): TokenStoreHarness<TAccount> {
    const seed = (opts.entries ?? (ingenEntries() as unknown as StoreEntry<TAccount>[])).map(
        (entry) => ({ ...entry }),
    )
    const entries: StoreEntry<TAccount>[] = seed
    const setBundleCalls: TokenStoreHarness<TAccount>['state']['setBundleCalls'] = []

    const tokenFor = (entry: StoreEntry<TAccount>): string =>
        entry.token ?? entry.bundle?.accessToken ?? `token-${entry.account.id}`
    const find = (ref?: AccountRef): StoreEntry<TAccount> | undefined =>
        ref === undefined
            ? entries.find((entry) => entry.isDefault)
            : entries.find((entry) => matchesRef(entry.account, ref))

    const activeSpy = vi.fn(async (ref?: AccountRef) => {
        const entry = find(ref)
        return entry ? { token: tokenFor(entry), account: entry.account } : null
    })
    const setSpy = vi.fn(async (account: TAccount, token: string) => {
        const entry = entries.find((e) => e.account.id === account.id)
        if (entry) entry.token = token
        else entries.push({ account, isDefault: entries.length === 0, token })
    })
    const clearSpy = vi.fn(async (ref?: AccountRef): Promise<ClearedAccount<TAccount> | null> => {
        const idx = entries.findIndex((entry) =>
            ref === undefined ? entry.isDefault : matchesRef(entry.account, ref),
        )
        if (idx === -1) return null
        const [removed] = entries.splice(idx, 1)
        return { account: removed.account, wasDefault: removed.isDefault }
    })
    const listSpy = vi.fn(async () =>
        entries.map((entry) => ({ account: entry.account, isDefault: entry.isDefault })),
    )
    const setDefaultSpy = vi.fn(async (ref: AccountRef) => {
        const target = entries.find((entry) => matchesRef(entry.account, ref))
        if (!target) throw new CliError('ACCOUNT_NOT_FOUND', `No stored account matches "${ref}".`)
        for (const entry of entries) entry.isDefault = entry === target
    })
    const activeBundleSpy = vi.fn(
        async (ref?: AccountRef): Promise<ActiveBundleSnapshot<TAccount> | null> => {
            const entry = find(ref)
            return entry?.bundle ? { account: entry.account, bundle: entry.bundle } : null
        },
    )
    const setBundleSpy = vi.fn(
        async (account: TAccount, bundle: TokenBundle, options?: unknown) => {
            setBundleCalls.push({ account, bundle, options })
            let entry = entries.find((e) => e.account.id === account.id)
            if (entry) entry.bundle = bundle
            else {
                entry = { account, isDefault: false, bundle }
                entries.push(entry)
            }
            // Honour `promoteDefault: true` (first login) by re-pinning the default;
            // a silent refresh omits it so a background rotation can't re-pin selection.
            if ((options as { promoteDefault?: boolean } | undefined)?.promoteDefault) {
                for (const e of entries) e.isDefault = e === entry
            }
        },
    )

    const store: TokenStore<TAccount> = {
        active: activeSpy as unknown as TokenStore<TAccount>['active'],
        set: setSpy as unknown as TokenStore<TAccount>['set'],
        clear: clearSpy as unknown as TokenStore<TAccount>['clear'],
        list: listSpy as unknown as TokenStore<TAccount>['list'],
        setDefault: setDefaultSpy as unknown as TokenStore<TAccount>['setDefault'],
        activeBundle: activeBundleSpy as unknown as TokenStore<TAccount>['activeBundle'],
        setBundle: setBundleSpy as unknown as TokenStore<TAccount>['setBundle'],
        ...opts.overrides,
    }

    return {
        store,
        activeSpy,
        clearSpy,
        listSpy,
        setDefaultSpy,
        state: { entries, setBundleCalls },
    }
}
