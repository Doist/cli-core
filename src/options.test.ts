import { describe, expect, expectTypeOf, it } from 'vitest'
import { type ListViewOptions, type ViewOptions, resolveOutputMode } from './options.js'

describe('ViewOptions', () => {
    it('declares json and ndjson as optional booleans', () => {
        const opts: ViewOptions = { json: true, ndjson: false }
        expectTypeOf(opts).toMatchTypeOf<{ json?: boolean; ndjson?: boolean }>()
    })

    it('accepts the empty object', () => {
        const empty: ViewOptions = {}
        expectTypeOf(empty).toMatchTypeOf<ViewOptions>()
    })

    it('is assignable from a wider per-CLI extension', () => {
        type ExtendedOptions = ViewOptions & { full?: boolean; workspace?: string }
        const wider: ExtendedOptions = { json: true, full: true, workspace: 'team' }
        const narrow: ViewOptions = wider
        expectTypeOf(narrow).toMatchTypeOf<ViewOptions>()
    })
})

describe('ListViewOptions', () => {
    it('adds the optional IDs-only flag to the canonical view options', () => {
        const opts: ListViewOptions = { idsOnly: true, json: false, ndjson: false }
        expectTypeOf(opts).toMatchTypeOf<{
            idsOnly?: boolean
            json?: boolean
            ndjson?: boolean
        }>()
    })
})

describe('resolveOutputMode', () => {
    it.each([
        [{}, 'human'],
        [{ json: true }, 'json'],
        [{ ndjson: true }, 'ndjson'],
        [{ idsOnly: true }, 'ids-only'],
    ] as const)('resolves %o to %s', (options, expected) => {
        expect(resolveOutputMode(options)).toBe(expected)
    })

    it.each([
        [{ json: true, ndjson: true }, 'Options --json, --ndjson are mutually exclusive.'],
        [{ json: true, idsOnly: true }, 'Options --json, --ids-only are mutually exclusive.'],
        [{ ndjson: true, idsOnly: true }, 'Options --ndjson, --ids-only are mutually exclusive.'],
    ])('rejects conflicting output flags in %o', (options, message) => {
        expect(() => resolveOutputMode(options)).toThrow(message)
    })
})
