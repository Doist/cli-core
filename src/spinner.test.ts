import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import yoctoSpinnerFactory from 'yocto-spinner'

import { createSpinner } from './spinner.js'

const mockSpinnerInstance = {
    start: vi.fn().mockReturnThis(),
    success: vi.fn(),
    error: vi.fn(),
    stop: vi.fn(),
    text: '',
}

vi.mock('yocto-spinner', () => ({
    default: vi.fn(() => mockSpinnerInstance),
}))

// Replace chalk with identity functions so the test sees raw text and the
// `chalk[color]` lookup never returns undefined.
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

beforeEach(() => {
    originalIsTTY = stdout.isTTY
    stdout.isTTY = true
    vi.clearAllMocks()
    mockSpinnerInstance.text = ''
})

afterEach(() => {
    stdout.isTTY = originalIsTTY
})

describe('withSpinner', () => {
    it('returns the operation result on success and stops the spinner', async () => {
        const { withSpinner } = createSpinner()
        const result = await withSpinner({ text: 'Working...' }, async () => 'ok')
        expect(result).toBe('ok')
        expect(mockSpinnerInstance.start).toHaveBeenCalled()
        expect(mockSpinnerInstance.stop).toHaveBeenCalled()
        expect(mockSpinnerInstance.error).not.toHaveBeenCalled()
    })

    it('rethrows the original error after fail()', async () => {
        const { withSpinner } = createSpinner()
        await expect(
            withSpinner({ text: 'Working...' }, async () => {
                throw new Error('boom')
            }),
        ).rejects.toThrow('boom')
        expect(mockSpinnerInstance.error).toHaveBeenCalled()
        expect(mockSpinnerInstance.stop).not.toHaveBeenCalled()
    })

    it('skips the spinner when noSpinner option is true', async () => {
        const { withSpinner } = createSpinner()
        const result = await withSpinner({ text: 'Working...', noSpinner: true }, async () => 'ok')
        expect(result).toBe('ok')
        expect(mockSpinnerInstance.start).not.toHaveBeenCalled()
    })

    it('skips the spinner when isDisabled returns true', async () => {
        const { withSpinner } = createSpinner({ isDisabled: () => true })
        await withSpinner({ text: 'Working...' }, async () => 'ok')
        expect(mockSpinnerInstance.start).not.toHaveBeenCalled()
    })

    it('skips the spinner when stdout is not a TTY', async () => {
        stdout.isTTY = false
        const { withSpinner } = createSpinner()
        await withSpinner({ text: 'Working...' }, async () => 'ok')
        expect(mockSpinnerInstance.start).not.toHaveBeenCalled()
    })
})

describe('LoadingSpinner', () => {
    it('starts and stops cleanly', () => {
        const { LoadingSpinner } = createSpinner()
        const s = new LoadingSpinner()
        s.start({ text: 'Working...' })
        expect(mockSpinnerInstance.start).toHaveBeenCalled()
        s.stop()
        expect(mockSpinnerInstance.stop).toHaveBeenCalled()
    })

    it('renders the success prefix', () => {
        const { LoadingSpinner } = createSpinner()
        const s = new LoadingSpinner()
        s.start({ text: 'Working...' })
        s.succeed('Done')
        expect(mockSpinnerInstance.success).toHaveBeenCalledWith('✓ Done')
    })

    it('renders the failure prefix', () => {
        const { LoadingSpinner } = createSpinner()
        const s = new LoadingSpinner()
        s.start({ text: 'Working...' })
        s.fail('Bad')
        expect(mockSpinnerInstance.error).toHaveBeenCalledWith('✗ Bad')
    })

    it('treats double-stop as a no-op', () => {
        const { LoadingSpinner } = createSpinner()
        const s = new LoadingSpinner()
        s.start({ text: 'Working...' })
        s.stop()
        s.stop()
        expect(mockSpinnerInstance.stop).toHaveBeenCalledTimes(1)
    })

    it('ignores succeed/fail when never started', () => {
        const { LoadingSpinner } = createSpinner()
        const s = new LoadingSpinner()
        s.succeed('Done')
        s.fail('Bad')
        expect(mockSpinnerInstance.success).not.toHaveBeenCalled()
        expect(mockSpinnerInstance.error).not.toHaveBeenCalled()
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
        expect(mockSpinnerInstance.start).toHaveBeenCalled()
        stopEarlySpinner()
        expect(mockSpinnerInstance.stop).toHaveBeenCalled()
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
        vi.clearAllMocks()

        const s = new LoadingSpinner()
        s.start({ text: 'Loading tasks...' })

        expect(yoctoSpinner).not.toHaveBeenCalled()
        expect(mockSpinnerInstance.start).not.toHaveBeenCalled()
        expect(mockSpinnerInstance.text).toBe('Loading tasks...')

        resetEarlySpinner()
    })

    it('releases on stop so the next call can re-adopt', () => {
        const { LoadingSpinner, startEarlySpinner, stopEarlySpinner, resetEarlySpinner } =
            createSpinner()
        startEarlySpinner()
        vi.clearAllMocks()

        const first = new LoadingSpinner()
        first.start({ text: 'Step 1' })
        first.stop()
        expect(mockSpinnerInstance.stop).not.toHaveBeenCalled()

        const second = new LoadingSpinner()
        second.start({ text: 'Step 2' })
        expect(mockSpinnerInstance.text).toBe('Step 2')

        second.stop()
        stopEarlySpinner()
        expect(mockSpinnerInstance.stop).toHaveBeenCalledTimes(1)

        resetEarlySpinner()
    })

    it('terminates on fail even when adopted (does not release back)', () => {
        const { LoadingSpinner, startEarlySpinner, stopEarlySpinner, resetEarlySpinner } =
            createSpinner()
        startEarlySpinner()
        vi.clearAllMocks()

        const s = new LoadingSpinner()
        s.start({ text: 'Working...' })
        s.fail('Boom')

        expect(mockSpinnerInstance.error).toHaveBeenCalled()
        stopEarlySpinner()
        expect(mockSpinnerInstance.stop).not.toHaveBeenCalled()

        resetEarlySpinner()
    })

    it('auto-stops when stdout is written to', () => {
        const { startEarlySpinner, resetEarlySpinner } = createSpinner()
        startEarlySpinner()
        process.stdout.write('hello\n')
        expect(mockSpinnerInstance.stop).toHaveBeenCalled()
        resetEarlySpinner()
    })

    it('isolates state between two kits in the same process', () => {
        const a = createSpinner()
        const b = createSpinner()
        a.startEarlySpinner()
        // b should not see a's instance — adoption only happens within the same kit.
        const s = new b.LoadingSpinner()
        s.start({ text: 'Independent' })
        expect(yoctoSpinner).toHaveBeenCalledTimes(2) // one per kit
        a.resetEarlySpinner()
        b.resetEarlySpinner()
    })
})
