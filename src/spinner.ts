import chalk from 'chalk'
import yoctoSpinner from 'yocto-spinner'
import { isStdoutTTY } from './terminal.js'

export type SpinnerColor = 'green' | 'yellow' | 'blue' | 'red' | 'gray' | 'cyan' | 'magenta'

export type SpinnerOptions = {
    text: string
    color?: SpinnerColor
    /** Per-call opt-out (e.g. when a flag like `--no-spinner` was passed). */
    noSpinner?: boolean
}

export type SpinnerConfig = {
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

export type LoadingSpinner = {
    start(options: SpinnerOptions): LoadingSpinner
    succeed(text?: string): void
    fail(text?: string): void
    stop(): void
}

export type SpinnerKit = {
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
    /**
     * @internal Reset internal state without calling `.stop()`. Exposed only
     * so consumer test suites can fully reset the kit between cases; do not
     * call from production code.
     */
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
    let stdoutInterceptor: typeof process.stdout.write | null = null

    function restoreStdoutWrite(): void {
        if (!originalStdoutWrite) return
        // Only restore if our interceptor is still on top — anything else that
        // monkey-patched process.stdout.write after us should keep its hook.
        if (process.stdout.write === stdoutInterceptor) {
            process.stdout.write = originalStdoutWrite
        }
        originalStdoutWrite = null
        stdoutInterceptor = null
    }

    function startEarlySpinner(text: string = earlyText): void {
        if (!isStdoutTTY() || isDisabled()) return

        earlyInstance = yoctoSpinner({ text: chalk[defaultColor](text) })
        earlyInstance.start()

        // Capture the original in a local closure variable (no .bind()) so
        // repeat startEarlySpinner calls don't nest .bind() copies, and so
        // the wrapper's reference survives `stopEarlySpinner` clearing the
        // module-level `originalStdoutWrite` field.
        const savedWrite = process.stdout.write
        originalStdoutWrite = savedWrite
        const wrapper = function (
            this: typeof process.stdout,
            ...args: Parameters<typeof process.stdout.write>
        ) {
            stopEarlySpinner()
            return savedWrite.apply(this, args)
        } as typeof process.stdout.write
        stdoutInterceptor = wrapper
        process.stdout.write = wrapper
    }

    function stopEarlySpinner(): void {
        restoreStdoutWrite()
        if (earlyInstance) {
            earlyInstance.stop()
            earlyInstance = null
        }
    }

    function resetEarlySpinner(): void {
        restoreStdoutWrite()
        earlyInstance = null
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
                // Adoption transfers stdout-clear responsibility to this
                // spinner. The early-spinner's stdout interceptor would
                // otherwise still fire (calling stopEarlySpinner with a now-
                // null earlyInstance) while the adopted spinner kept running.
                restoreStdoutWrite()
                this.instance.text = colorFn(options.text)
                return this
            }

            this.instance = yoctoSpinner({ text: colorFn(options.text) })
            this.instance.start()
            return this
        }

        /** Release an adopted spinner back to the pool. Returns true if released. */
        private releaseAdopted(): boolean {
            if (!this.adopted || !this.instance) return false
            earlyInstance = this.instance
            this.instance = null
            this.adopted = false
            return true
        }

        succeed(text?: string): void {
            if (!this.instance) return
            // Release-back is silent; only do it when the caller didn't ask
            // for a visible success line. With text, the user wants the
            // checkmark + message and we terminate.
            if (text === undefined && this.releaseAdopted()) return
            // yocto-spinner prepends its own ✔ glyph; passing the bare text
            // (coloured) avoids a duplicated symbol.
            this.instance.success(text ? chalk.green(text) : undefined)
            this.instance = null
            this.adopted = false
        }

        fail(text?: string): void {
            if (!this.instance) return
            // yocto-spinner prepends its own ✖ glyph; passing the bare text
            // (coloured) avoids a duplicated symbol. Errors always terminate.
            this.instance.error(text ? chalk.red(text) : undefined)
            this.instance = null
            this.adopted = false
        }

        stop(): void {
            if (!this.instance) return
            if (this.releaseAdopted()) return
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
