import { vi } from 'vitest'

import type {
    AccountRef,
    ActiveBundleSnapshot,
    AuthAccount,
    ClearedAccount,
    TokenBundle,
    TokenStore,
} from '../auth/types.js'
import { accountNotFoundError } from '../auth/user-flag.js'

// Shared account fixtures + a canonical in-memory `TokenStore` mock for auth
// test suites, shipped via the `@doist/cli-core/testing` subpath so consuming
// CLIs can reuse them instead of hand-rolling store mocks.
//
// The mock mirrors `createKeyringTokenStore`'s default-selection rules so tests
// can't assert states production never produces: the *effective default* is the
// pinned default when present, else the sole stored account; promotion only
// pins when nothing is pinned yet.

export type TestAccount = { id: string; label?: string; email: string }

export const alanGrant: TestAccount = { id: '1', label: 'Alan Grant', email: 'alan@ingen.com' }
export const ellieSattler: TestAccount = {
    id: '2',
    label: 'Ellie Sattler',
    email: 'ellie@ingen.com',
}
export const ianMalcolm: TestAccount = { id: '3', label: 'Ian Malcolm', email: 'ian@ingen.com' }

export type StoreEntry<TAccount extends AuthAccount = TestAccount> = {
    account: TAccount
    /** Seeds the pinned default; after construction the default is tracked separately. */
    isDefault: boolean
    /** Access token returned by `active()`. Defaults to `bundle.accessToken` or `token-<id>`. */
    token?: string
    /** Full bundle returned by `activeBundle()`. */
    bundle?: TokenBundle
}

/** Fresh default seed: Alan (pinned default) + Ellie. Copy so callers can mutate safely. */
export function ingenEntries(): StoreEntry[] {
    return [
        { account: alanGrant, isDefault: true },
        { account: ellieSattler, isDefault: false },
    ]
}

/** Account matcher used to resolve a ref. The default matches by id, email, or label. */
export type MatchAccount<TAccount extends AuthAccount> = (
    account: TAccount,
    ref: AccountRef,
) => boolean

/** Default ref matcher: id, email, or label. Pass a consumer's own matcher via `matchAccount`. */
function defaultMatchAccount(account: AuthAccount, ref: AccountRef): boolean {
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

export function buildTokenStore(opts?: {
    entries?: StoreEntry<TestAccount>[]
    overrides?: Partial<TokenStore<TestAccount>>
    matchAccount?: MatchAccount<TestAccount>
}): TokenStoreHarness<TestAccount>
export function buildTokenStore<TAccount extends AuthAccount>(opts: {
    entries: StoreEntry<TAccount>[]
    overrides?: Partial<TokenStore<TAccount>>
    matchAccount?: MatchAccount<TAccount>
}): TokenStoreHarness<TAccount>
/**
 * Canonical stateful, multi-account `TokenStore` mock. Models the full contract
 * over a mutable entry list — ref matching, effective-default resolution,
 * promote-if-unpinned, token-free removal returning `ClearedAccount`, and bundle
 * read/write with slot replacement. The default Ingen seed only applies to
 * `TestAccount`; other `TAccount`s must pass explicit `entries`. Ref matching
 * defaults to id/email/label; pass `matchAccount` to mirror a consumer's own
 * store matcher (e.g. numeric-id or case-insensitive label rules). Pass
 * `overrides` to replace (or delete, via `{ method: undefined }`) any method.
 */
export function buildTokenStore<TAccount extends AuthAccount = TestAccount>(
    opts: {
        entries?: StoreEntry<TAccount>[]
        overrides?: Partial<TokenStore<TAccount>>
        matchAccount?: MatchAccount<TAccount>
    } = {},
): TokenStoreHarness<TAccount> {
    const matches: MatchAccount<TAccount> = opts.matchAccount ?? defaultMatchAccount
    const entries: StoreEntry<TAccount>[] = (
        opts.entries ?? (ingenEntries() as unknown as StoreEntry<TAccount>[])
    ).map((entry) => ({ ...entry }))
    let pinnedDefaultId: string | null =
        entries.find((entry) => entry.isDefault)?.account.id ?? null
    const setBundleCalls: TokenStoreHarness<TAccount>['state']['setBundleCalls'] = []

    // Pinned default if it still resolves, else the sole stored account, else
    // none (no records, or several with no pin) — mirrors `effectiveDefault`.
    const effectiveDefault = (): StoreEntry<TAccount> | undefined => {
        if (pinnedDefaultId) {
            const pinned = entries.find((entry) => entry.account.id === pinnedDefaultId)
            if (pinned) return pinned
        }
        return entries.length === 1 ? entries[0] : undefined
    }
    const promoteIfUnpinned = (id: string): void => {
        if (!pinnedDefaultId) pinnedDefaultId = id
    }
    const tokenFor = (entry: StoreEntry<TAccount>): string =>
        entry.token ?? entry.bundle?.accessToken ?? `token-${entry.account.id}`
    const find = (ref?: AccountRef): StoreEntry<TAccount> | undefined =>
        ref === undefined ? effectiveDefault() : entries.find((e) => matches(e.account, ref))

    const activeSpy = vi.fn(async (ref?: AccountRef) => {
        const entry = find(ref)
        return entry ? { token: tokenFor(entry), account: entry.account } : null
    })
    const setSpy = vi.fn(async (account: TAccount, token: string) => {
        const entry = entries.find((e) => e.account.id === account.id)
        // A fresh write replaces the prior credential shape: drop any stale bundle.
        if (entry) {
            entry.token = token
            entry.bundle = undefined
        } else {
            entries.push({ account, isDefault: false, token })
        }
        promoteIfUnpinned(account.id)
    })
    const clearSpy = vi.fn(async (ref?: AccountRef): Promise<ClearedAccount<TAccount> | null> => {
        const target = find(ref)
        if (!target) return null
        const wasDefault = effectiveDefault()?.account.id === target.account.id
        entries.splice(entries.indexOf(target), 1)
        if (pinnedDefaultId === target.account.id) pinnedDefaultId = null
        return { account: target.account, wasDefault }
    })
    const listSpy = vi.fn(async () => {
        const defaultId = effectiveDefault()?.account.id
        return entries.map((entry) => ({
            account: entry.account,
            isDefault: entry.account.id === defaultId,
        }))
    })
    const setDefaultSpy = vi.fn(async (ref: AccountRef) => {
        const target = entries.find((e) => matches(e.account, ref))
        if (!target) throw accountNotFoundError(ref)
        pinnedDefaultId = target.account.id
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
            const entry = entries.find((e) => e.account.id === account.id)
            // A fresh write replaces the prior credential shape: drop any stale token.
            if (entry) {
                entry.bundle = bundle
                entry.token = undefined
            } else {
                entries.push({ account, isDefault: false, bundle })
            }
            if ((options as { promoteDefault?: boolean } | undefined)?.promoteDefault) {
                promoteIfUnpinned(account.id)
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

/**
 * Single-account convenience over {@link buildTokenStore} — the shape the
 * `logout` / `status` / `token-view` / `user-flag` suites share. `initial`
 * mirrors a `store.active()` snapshot (token + account), or `null` for an
 * empty store.
 */
export function buildSingleEntryStore(
    initial: { token: string; account: TestAccount } | null,
    overrides?: Partial<TokenStore<TestAccount>>,
): TokenStoreHarness<TestAccount> {
    return buildTokenStore({
        entries: initial
            ? [{ account: initial.account, isDefault: true, token: initial.token }]
            : [],
        overrides,
    })
}
