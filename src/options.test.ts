import { describe, expectTypeOf, it } from 'vitest'
import type { ViewOptions } from './options.js'

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
