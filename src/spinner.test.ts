import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import yoctoSpinnerFactory from 'yocto-spinner'

import { createSpinner } from './spinner.js'

type MockSpinner = {
    start: ReturnType<typeof vi.fn>
    success: ReturnType<typeof vi.fn>
    error: ReturnType<typeof vi.fn>
    stop: ReturnType<typeof vi.fn>
    text: string
}

function makeMockSpinner(): MockSpinner {
    const m: MockSpinner = {
        start: vi.fn().mockReturnThis(),
        success: vi.fn(),
        error: vi.fn(),
        stop: vi.fn(),
        text: '',
    }
    return m
}

// Each yoctoSpinner() call returns a fresh mock so isolation tests verify
// real per-instance behaviour rather than mutations on a shared object.
const createdSpinners: MockSpinner[] = []
vi.mock('yocto-spinner', () => ({
    default: vi.fn((options: { text?: string } = {}) => {
        const m = makeMockSpinner()
        if (options.text !== undefined) m.text = options.text
        createdSpinners.push(m)
        return m
    }),
}))

// chalk auto-mock would yield undefined functions; replace with identity so
// `chalk[color]` returns a passthrough and the tests see raw text.
vi.mock('chalk', () => {
    const identity = (s: string) => s
    return {
        default: new Proxy(identity, {
            get: () => identity,
        }),
    }
})

const stdout = process.stdout as unknown as { isTTY?: boolean }
let originalIsTTY: boolean | undefined
let stdoutWriteSpy: ReturnType<typeof vi.spyOn> | undefined

beforeEach(() => {
    originalIsTTY = stdout.isTTY
    stdout.isTTY = true
    createdSpinners.length = 0
    vi.clearAllMocks()
    // Swallow the early-spinner interceptor's actual writes so test runner
    // output stays clean.
    stdoutWriteSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
})

afterEach(() => {
    stdout.isTTY = originalIsTTY
    stdoutWriteSpy?.mockRestore()
    stdoutWriteSpy = undefined
})

const lastSpinner = (): MockSpinner => createdSpinners[createdSpinners.length - 1]!

describe('withSpinner', () => {
    it('returns the operation result on success and stops the spinner', async () => {
        const { withSpinner } = createSpinner()
        const result = await withSpinner({ text: 'Working...' }, async () => 'ok')
        expect(result).toBe('ok')
        expect(lastSpinner().start).toHaveBeenCalled()
        expect(lastSpinner().stop).toHaveBeenCalled()
        expect(lastSpinner().error).not.toHaveBeenCalled()
    })

    it('rethrows the original error after fail()', async () => {
        const { withSpinner } = createSpinner()
        await expect(
            withSpinner({ text: 'Working...' }, async () => {
                throw new Error('boom')
            }),
        ).rejects.toThrow('boom')
        expect(lastSpinner().error).toHaveBeenCalled()
        expect(lastSpinner().stop).not.toHaveBeenCalled()
    })

    it('skips the spinner when noSpinner option is true', async () => {
        const { withSpinner } = createSpinner()
        const result = await withSpinner({ text: 'Working...', noSpinner: true }, async () => 'ok')
        expect(result).toBe('ok')
        expect(createdSpinners).toHaveLength(0)
    })

    it('skips the spinner when isDisabled returns true', async () => {
        const { withSpinner } = createSpinner({ isDisabled: () => true })
        await withSpinner({ text: 'Working...' }, async () => 'ok')
        expect(createdSpinners).toHaveLength(0)
    })

    it('skips the spinner when stdout is not a TTY', async () => {
        stdout.isTTY = false
        const { withSpinner } = createSpinner()
        await withSpinner({ text: 'Working...' }, async () => 'ok')
        expect(createdSpinners).toHaveLength(0)
    })
})

describe('LoadingSpinner', () => {
    it('starts and stops cleanly', () => {
        const { LoadingSpinner } = createSpinner()
        const s = new LoadingSpinner()
        s.start({ text: 'Working...' })
        expect(lastSpinner().start).toHaveBeenCalled()
        s.stop()
        expect(lastSpinner().stop).toHaveBeenCalled()
    })

    it('passes the bare success text to yocto-spinner (no manual ✓ prefix)', () => {
        const { LoadingSpinner } = createSpinner()
        const s = new LoadingSpinner()
        s.start({ text: 'Working...' })
        s.succeed('Done')
        // yocto-spinner prepends its own ✔, so we must not duplicate it.
        expect(lastSpinner().success).toHaveBeenCalledWith('Done')
    })

    it('passes the bare failure text to yocto-spinner (no manual ✗ prefix)', () => {
        const { LoadingSpinner } = createSpinner()
        const s = new LoadingSpinner()
        s.start({ text: 'Working...' })
        s.fail('Bad')
        expect(lastSpinner().error).toHaveBeenCalledWith('Bad')
    })

    it('treats double-stop as a no-op', () => {
        const { LoadingSpinner } = createSpinner()
        const s = new LoadingSpinner()
        s.start({ text: 'Working...' })
        s.stop()
        s.stop()
        expect(lastSpinner().stop).toHaveBeenCalledTimes(1)
    })

    it('ignores succeed/fail when never started', () => {
        const { LoadingSpinner } = createSpinner()
        const s = new LoadingSpinner()
        s.succeed('Done')
        s.fail('Bad')
        expect(createdSpinners).toHaveLength(0)
    })
})

describe('early spinner', () => {
    const yoctoSpinner = vi.mocked(yoctoSpinnerFactory)

    it('starts and stops with the configured early text', () => {
        const { startEarlySpinner, stopEarlySpinner } = createSpinner({
            earlySpinnerText: 'Booting…',
        })
        startEarlySpinner()
        expect(yoctoSpinner).toHaveBeenCalledWith({ text: 'Booting…' })
        expect(lastSpinner().start).toHaveBeenCalled()
        stopEarlySpinner()
        expect(lastSpinner().stop).toHaveBeenCalled()
    })

    it('skips the early spinner when not in a TTY', () => {
        stdout.isTTY = false
        const { startEarlySpinner } = createSpinner()
        startEarlySpinner()
        expect(yoctoSpinner).not.toHaveBeenCalled()
    })

    it('skips the early spinner when isDisabled returns true', () => {
        const { startEarlySpinner } = createSpinner({ isDisabled: () => true })
        startEarlySpinner()
        expect(yoctoSpinner).not.toHaveBeenCalled()
    })

    it('is adopted by LoadingSpinner.start — reuses the instance and updates the text', () => {
        const { LoadingSpinner, startEarlySpinner, resetEarlySpinner } = createSpinner()
        startEarlySpinner()
        const earlyMock = lastSpinner()
        vi.clearAllMocks()

        const s = new LoadingSpinner()
        s.start({ text: 'Loading tasks...' })

        expect(yoctoSpinner).not.toHaveBeenCalled()
        expect(earlyMock.start).not.toHaveBeenCalled()
        expect(earlyMock.text).toBe('Loading tasks...')

        resetEarlySpinner()
    })

    it('on adoption restores stdout.write so subsequent output does not interleave', () => {
        const { LoadingSpinner, startEarlySpinner, resetEarlySpinner } = createSpinner()
        startEarlySpinner()
        const wrapped = process.stdout.write
        new LoadingSpinner().start({ text: 'Adopted' })
        // Writing after adoption must call the underlying spy directly,
        // not the early-spinner interceptor (which would call stop() on a
        // no-longer-tracked instance and leave the adopted spinner running).
        expect(process.stdout.write).not.toBe(wrapped)

        resetEarlySpinner()
    })

    it('releases on stop so the next call can re-adopt', () => {
        const { LoadingSpinner, startEarlySpinner, stopEarlySpinner, resetEarlySpinner } =
            createSpinner()
        startEarlySpinner()
        const earlyMock = lastSpinner()
        vi.clearAllMocks()

        const first = new LoadingSpinner()
        first.start({ text: 'Step 1' })
        first.stop()
        expect(earlyMock.stop).not.toHaveBeenCalled()

        const second = new LoadingSpinner()
        second.start({ text: 'Step 2' })
        expect(earlyMock.text).toBe('Step 2')

        second.stop()
        stopEarlySpinner()
        expect(earlyMock.stop).toHaveBeenCalledTimes(1)

        resetEarlySpinner()
    })

    it('terminates on succeed(text) even when adopted (with the bare text)', () => {
        const { LoadingSpinner, startEarlySpinner, stopEarlySpinner, resetEarlySpinner } =
            createSpinner()
        startEarlySpinner()
        const earlyMock = lastSpinner()
        vi.clearAllMocks()

        const s = new LoadingSpinner()
        s.start({ text: 'Working...' })
        s.succeed('Done')

        // yocto-spinner.success() called with the message (yocto adds its own ✔)
        expect(earlyMock.success).toHaveBeenCalledWith('Done')

        // Adopted instance was terminated, so cleanup at the kit level is a no-op
        // for the underlying mock.
        stopEarlySpinner()
        expect(earlyMock.stop).not.toHaveBeenCalled()

        resetEarlySpinner()
    })

    it('releases silently on succeed() with no text (chained-call pattern)', () => {
        const { LoadingSpinner, startEarlySpinner, stopEarlySpinner, resetEarlySpinner } =
            createSpinner()
        startEarlySpinner()
        const earlyMock = lastSpinner()
        vi.clearAllMocks()

        const first = new LoadingSpinner()
        first.start({ text: 'Step 1' })
        first.succeed()
        expect(earlyMock.success).not.toHaveBeenCalled()

        const second = new LoadingSpinner()
        second.start({ text: 'Step 2' })
        expect(earlyMock.text).toBe('Step 2')

        stopEarlySpinner()
        resetEarlySpinner()
    })

    it('terminates on fail even when adopted (does not release back)', () => {
        const { LoadingSpinner, startEarlySpinner, stopEarlySpinner, resetEarlySpinner } =
            createSpinner()
        startEarlySpinner()
        const earlyMock = lastSpinner()
        vi.clearAllMocks()

        const s = new LoadingSpinner()
        s.start({ text: 'Working...' })
        s.fail('Boom')

        expect(earlyMock.error).toHaveBeenCalledWith('Boom')
        stopEarlySpinner()
        expect(earlyMock.stop).not.toHaveBeenCalled()

        resetEarlySpinner()
    })

    it('auto-stops when stdout is written to', () => {
        const { startEarlySpinner, resetEarlySpinner } = createSpinner()
        startEarlySpinner()
        const earlyMock = lastSpinner()
        process.stdout.write('hello\n')
        expect(earlyMock.stop).toHaveBeenCalled()
        resetEarlySpinner()
    })

    it('leaves a foreign stdout.write hook intact when restoring', () => {
        const { startEarlySpinner, stopEarlySpinner, resetEarlySpinner } = createSpinner()
        startEarlySpinner()
        // Another tool monkey-patches stdout.write on top of ours.
        const foreignHook = ((..._args: unknown[]) => true) as typeof process.stdout.write
        process.stdout.write = foreignHook
        stopEarlySpinner()
        // We must not clobber the foreign hook.
        expect(process.stdout.write).toBe(foreignHook)
        resetEarlySpinner()
    })

    it('isolates state between two kits in the same process', () => {
        const a = createSpinner()
        const b = createSpinner()
        a.startEarlySpinner()
        const aMock = lastSpinner()
        // b should not see a's instance — adoption only happens within the same kit.
        const s = new b.LoadingSpinner()
        s.start({ text: 'Independent' })
        const bMock = lastSpinner()
        expect(aMock).not.toBe(bMock)
        expect(aMock.text).toBe('Loading...')
        expect(bMock.text).toBe('Independent')
        a.resetEarlySpinner()
        b.resetEarlySpinner()
    })
})
