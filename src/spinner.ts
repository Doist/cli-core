import chalk from 'chalk'
import yoctoSpinner from 'yocto-spinner'
import { isStdoutTTY } from './terminal.js'

export type SpinnerColor = 'green' | 'yellow' | 'blue' | 'red' | 'gray' | 'cyan' | 'magenta'

export interface SpinnerOptions {
    text: string
    color?: SpinnerColor
    /** Per-call opt-out (e.g. when a flag like `--no-spinner` was passed). */
    noSpinner?: boolean
}

export interface SpinnerConfig {
    /**
     * Returns true to suppress every spinner produced by this kit. CLIs
     * supply this to combine well-known signals (CI, `--json`, etc.) with
     * their own opt-out env vars (e.g. `TD_SPINNER=false`).
     *
     * Defaults to `() => false`.
     */
    isDisabled?: () => boolean
    /** Default colour name. Defaults to `'blue'`. */
    defaultColor?: SpinnerColor
    /** Default text shown by `startEarlySpinner` when no override is passed. */
    earlySpinnerText?: string
}

export interface LoadingSpinner {
    start(options: SpinnerOptions): this
    succeed(text?: string): void
    fail(text?: string): void
    stop(): void
}

export interface SpinnerKit {
    /** Class so consumers can use `new spinner.LoadingSpinner()` if they want
     *  to manage start/stop manually. Most call sites should prefer `withSpinner`. */
    LoadingSpinner: new () => LoadingSpinner
    /** Run an async operation flanked by a spinner. Stops on success, fails on throw. */
    withSpinner: <T>(options: SpinnerOptions, op: () => Promise<T>) => Promise<T>
    /** Show a long-running spinner before the command module loads. Intercepts
     *  stdout.write so it auto-clears the moment any output is produced. */
    startEarlySpinner: (text?: string) => void
    /** Stop the early spinner if running and restore stdout.write. */
    stopEarlySpinner: () => void
    /** Reset internal state without calling .stop() — for tests. */
    resetEarlySpinner: () => void
}

/**
 * Build a spinner kit configured for one CLI. Each kit owns its own early-
 * spinner singleton state, so two kits running in the same process don't
 * step on each other.
 *
 * ```ts
 * import { createSpinner } from '@doist/cli-core'
 * import { shouldDisableSpinner } from './global-args.js'
 *
 * const { LoadingSpinner, withSpinner, startEarlySpinner, stopEarlySpinner } =
 *     createSpinner({ isDisabled: shouldDisableSpinner })
 * ```
 */
export function createSpinner(config: SpinnerConfig = {}): SpinnerKit {
    const isDisabled = config.isDisabled ?? (() => false)
    const defaultColor: SpinnerColor = config.defaultColor ?? 'blue'
    const earlyText = config.earlySpinnerText ?? 'Loading...'

    let earlyInstance: ReturnType<typeof yoctoSpinner> | null = null
    let originalStdoutWrite: typeof process.stdout.write | null = null

    function startEarlySpinner(text: string = earlyText): void {
        if (!isStdoutTTY() || isDisabled()) return

        earlyInstance = yoctoSpinner({ text: chalk[defaultColor](text) })
        earlyInstance.start()

        const savedWrite = process.stdout.write.bind(process.stdout) as typeof process.stdout.write
        originalStdoutWrite = savedWrite
        process.stdout.write = function (
            this: typeof process.stdout,
            ...args: Parameters<typeof process.stdout.write>
        ) {
            stopEarlySpinner()
            return savedWrite.apply(this, args)
        } as typeof process.stdout.write
    }

    function stopEarlySpinner(): void {
        if (originalStdoutWrite) {
            process.stdout.write = originalStdoutWrite
            originalStdoutWrite = null
        }
        if (earlyInstance) {
            earlyInstance.stop()
            earlyInstance = null
        }
    }

    function resetEarlySpinner(): void {
        earlyInstance = null
        if (originalStdoutWrite) {
            process.stdout.write = originalStdoutWrite
            originalStdoutWrite = null
        }
    }

    class LoadingSpinnerImpl implements LoadingSpinner {
        private instance: ReturnType<typeof yoctoSpinner> | null = null
        private adopted = false

        start(options: SpinnerOptions): this {
            if (!isStdoutTTY() || options.noSpinner || isDisabled()) {
                return this
            }

            const colorFn = chalk[options.color ?? defaultColor]

            // Adopt an existing early spinner if one's running rather than
            // stacking a second one on top.
            if (earlyInstance) {
                this.instance = earlyInstance
                this.adopted = true
                earlyInstance = null
                this.instance.text = colorFn(options.text)
                return this
            }

            this.instance = yoctoSpinner({ text: colorFn(options.text) })
            this.instance.start()
            return this
        }

        succeed(text?: string): void {
            if (!this.instance) return
            if (this.adopted) {
                // Release back to the early-spinner pool so the next API call
                // can re-adopt instead of starting another.
                earlyInstance = this.instance
                this.instance = null
                this.adopted = false
                return
            }
            this.instance.success(text ? chalk.green(`✓ ${text}`) : undefined)
            this.instance = null
        }

        fail(text?: string): void {
            if (!this.instance) return
            // Errors always terminate the spinner — never released back.
            this.instance.error(text ? chalk.red(`✗ ${text}`) : undefined)
            this.instance = null
            this.adopted = false
        }

        stop(): void {
            if (!this.instance) return
            if (this.adopted) {
                earlyInstance = this.instance
                this.instance = null
                this.adopted = false
                return
            }
            this.instance.stop()
            this.instance = null
        }
    }

    async function withSpinner<T>(options: SpinnerOptions, op: () => Promise<T>): Promise<T> {
        const spinner = new LoadingSpinnerImpl().start(options)
        try {
            const result = await op()
            spinner.stop()
            return result
        } catch (error) {
            spinner.fail()
            throw error
        }
    }

    return {
        LoadingSpinner: LoadingSpinnerImpl,
        withSpinner,
        startEarlySpinner,
        stopEarlySpinner,
        resetEarlySpinner,
    }
}
