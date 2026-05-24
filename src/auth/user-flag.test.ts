import { Command } from 'commander'
import { describe, expect, it, vi } from 'vitest'

import { CliError } from '../errors.js'
import { buildProgram } from '../test-support/cli-harness.js'
import {
    type TestAccount as Account,
    alanGrant,
    buildSingleEntryStore,
} from '../testing/accounts.js'
import type { TokenStore } from './types.js'
import { attachUserFlag, extractUserRef, requireSnapshotForRef } from './user-flag.js'

const account = alanGrant

function buildStore(
    initial: { token: string; account: Account } | null = { token: 'tok', account },
): TokenStore<Account> {
    return buildSingleEntryStore(initial).store
}

describe('attachUserFlag', () => {
    it('attaches `--user <ref>` with a generic description', async () => {
        const { program, parent: sub } = buildProgram('sub')
        attachUserFlag(sub).action(() => {})

        await program.parseAsync(['node', 'cli', 'sub', '--user', 'alice'])

        expect(sub.opts().user).toBe('alice')
        const help = sub.helpInformation()
        expect(help).toContain('--user <ref>')
        // Description must not bake in any resolver-specific matching policy.
        expect(help).not.toMatch(/id or label|email/i)
    })

    it('returns the command so callers can chain', () => {
        const command = new Command('sub')
        expect(attachUserFlag(command)).toBe(command)
    })
})

describe('extractUserRef', () => {
    it.each([
        [{ user: 'alice' }, 'alice'],
        [{ user: '' }, ''],
        [{}, undefined],
        [{ user: undefined }, undefined],
        [{ user: true }, undefined],
        [{ user: 42 }, undefined],
    ] as const)('reads %j -> %j', (cmd, expected) => {
        expect(extractUserRef(cmd)).toBe(expected)
    })
})

describe('requireSnapshotForRef', () => {
    it('returns the snapshot when ref matches', async () => {
        const store = buildStore({ token: 'tok', account })

        const snapshot = await requireSnapshotForRef(store, 'alan@ingen.com')

        expect(snapshot).toEqual({ token: 'tok', account })
        expect(store.active).toHaveBeenCalledWith('alan@ingen.com')
    })

    it('returns null when ref is undefined and the store is empty', async () => {
        const store = buildStore(null)

        const snapshot = await requireSnapshotForRef(store, undefined)

        expect(snapshot).toBeNull()
        expect(store.active).toHaveBeenCalledWith(undefined)
    })

    it('throws ACCOUNT_NOT_FOUND when ref is supplied but store.active returns null', async () => {
        const store = buildStore(null)

        await expect(requireSnapshotForRef(store, 'ghost')).rejects.toMatchObject({
            constructor: CliError,
            code: 'ACCOUNT_NOT_FOUND',
        })
    })

    it('propagates store.active errors verbatim', async () => {
        const store = buildStore()
        ;(store.active as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
            new Error('keychain offline'),
        )

        await expect(requireSnapshotForRef(store, 'alice')).rejects.toThrow('keychain offline')
    })
})
