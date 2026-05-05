import { describe, expect, it } from 'vitest'

import { formatJson, formatNdjson } from './json.js'

describe('formatJson', () => {
    it('pretty-prints objects with 2-space indentation', () => {
        expect(formatJson({ a: 1, b: 'two' })).toBe('{\n  "a": 1,\n  "b": "two"\n}')
    })

    it('pretty-prints arrays', () => {
        expect(formatJson([1, 2, 3])).toBe('[\n  1,\n  2,\n  3\n]')
    })

    it('handles primitives', () => {
        expect(formatJson(42)).toBe('42')
        expect(formatJson('hello')).toBe('"hello"')
        expect(formatJson(true)).toBe('true')
        expect(formatJson(null)).toBe('null')
    })

    it('omits undefined fields like JSON.stringify', () => {
        expect(formatJson({ a: 1, b: undefined })).toBe('{\n  "a": 1\n}')
    })

    it('handles nested structures', () => {
        const result = formatJson({ outer: { inner: [1, 2] } })
        expect(result).toBe('{\n  "outer": {\n    "inner": [\n      1,\n      2\n    ]\n  }\n}')
    })

    it('throws when the top-level value is not JSON-serializable', () => {
        expect(() => formatJson(undefined)).toThrow(/not JSON-serializable/)
        expect(() => formatJson(() => 0)).toThrow(/not JSON-serializable/)
        expect(() => formatJson(Symbol('x'))).toThrow(/not JSON-serializable/)
    })
})

describe('formatNdjson', () => {
    it('formats one JSON value per line, no trailing newline', () => {
        expect(formatNdjson([{ a: 1 }, { a: 2 }])).toBe('{"a":1}\n{"a":2}')
    })

    it('returns an empty string for an empty array', () => {
        expect(formatNdjson([])).toBe('')
    })

    it('handles a single item with no separator', () => {
        expect(formatNdjson([{ a: 1 }])).toBe('{"a":1}')
    })

    it('uses \\n (LF), not \\r\\n', () => {
        const result = formatNdjson([{ a: 1 }, { a: 2 }])
        expect(result).not.toContain('\r')
        expect(result.split('\n')).toHaveLength(2)
    })

    it('handles primitives in the array', () => {
        expect(formatNdjson([1, 'two', null, true])).toBe('1\n"two"\nnull\ntrue')
    })

    it('preserves insertion order', () => {
        const items = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
        const lines = formatNdjson(items).split('\n')
        expect(lines.map((line) => JSON.parse(line).id)).toEqual(['a', 'b', 'c'])
    })

    it('throws with the bad index when an item is not JSON-serializable', () => {
        expect(() => formatNdjson([1, undefined, 2])).toThrow(/index 1.*not JSON-serializable/)
        expect(() => formatNdjson([() => 0])).toThrow(/index 0/)
        expect(() => formatNdjson([Symbol('x')])).toThrow(/index 0/)
    })
})
