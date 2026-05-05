import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { isCI, isStderrTTY, isStdinTTY, isStdoutTTY } from './terminal.js'

type IsTTYHolder = { isTTY?: boolean }

const stdout = process.stdout as unknown as IsTTYHolder
const stdin = process.stdin as unknown as IsTTYHolder
const stderr = process.stderr as unknown as IsTTYHolder

let originalStdoutIsTTY: boolean | undefined
let originalStdinIsTTY: boolean | undefined
let originalStderrIsTTY: boolean | undefined
let originalCI: string | undefined

beforeEach(() => {
    originalStdoutIsTTY = stdout.isTTY
    originalStdinIsTTY = stdin.isTTY
    originalStderrIsTTY = stderr.isTTY
    originalCI = process.env.CI
})

afterEach(() => {
    stdout.isTTY = originalStdoutIsTTY
    stdin.isTTY = originalStdinIsTTY
    stderr.isTTY = originalStderrIsTTY
    if (originalCI === undefined) delete process.env.CI
    else process.env.CI = originalCI
})

describe('isStdoutTTY', () => {
    it('returns true when stdout is a TTY', () => {
        stdout.isTTY = true
        expect(isStdoutTTY()).toBe(true)
    })

    it('returns false when stdout is not a TTY', () => {
        stdout.isTTY = false
        expect(isStdoutTTY()).toBe(false)
    })

    it('returns false when isTTY is undefined (piped output)', () => {
        stdout.isTTY = undefined
        expect(isStdoutTTY()).toBe(false)
    })
})

describe('isStdinTTY', () => {
    it('returns true when stdin is a TTY', () => {
        stdin.isTTY = true
        expect(isStdinTTY()).toBe(true)
    })

    it('returns false when stdin is piped', () => {
        stdin.isTTY = undefined
        expect(isStdinTTY()).toBe(false)
    })
})

describe('isStderrTTY', () => {
    it('returns true when stderr is a TTY', () => {
        stderr.isTTY = true
        expect(isStderrTTY()).toBe(true)
    })

    it('returns false when stderr is not a TTY', () => {
        stderr.isTTY = false
        expect(isStderrTTY()).toBe(false)
    })
})

describe('isCI', () => {
    it('returns true when CI is set to a truthy value', () => {
        process.env.CI = 'true'
        expect(isCI()).toBe(true)
    })

    it('returns true for any non-empty CI value (e.g. "1")', () => {
        process.env.CI = '1'
        expect(isCI()).toBe(true)
    })

    it('returns false when CI is unset', () => {
        delete process.env.CI
        expect(isCI()).toBe(false)
    })

    it('returns false when CI is the empty string', () => {
        process.env.CI = ''
        expect(isCI()).toBe(false)
    })
})
