import type { Marked } from 'marked'
import type { TerminalRendererOptions } from 'marked-terminal-renderer'

export type { TerminalRendererOptions } from 'marked-terminal-renderer'

export type PreloadMarkdownOptions = {
    /** Theme to drive the renderer; defaults to `darkTheme()`. */
    theme?: TerminalRendererOptions
}

let markedInstance: Marked | null = null

/**
 * Lazy-init a shared `marked` renderer for terminal output. Idempotent — safe
 * to call multiple times; later calls are no-ops once initialised, so the
 * `theme` from the first call wins.
 *
 * Defer the dynamic import to the call site so CLIs that never render
 * markdown (e.g. `--json` / `--ndjson` runs) don't pay the load cost. The
 * peer-dep packages (`marked`, `marked-terminal-renderer`) are loaded only
 * inside this function — a missing peer surfaces here as a friendly error,
 * never as a module-link crash on `import`.
 *
 * ```ts
 * import { preloadMarkdown, renderMarkdown } from '@doist/cli-core/markdown'
 *
 * if (!options.json && !options.raw) {
 *     await preloadMarkdown()
 * }
 * console.log(await renderMarkdown(comment.body))
 * ```
 *
 * Custom theme — import directly from the renderer package, which the
 * consumer already has installed as a peer-dep:
 *
 * ```ts
 * import { preloadMarkdown } from '@doist/cli-core/markdown'
 * import { lightTheme } from 'marked-terminal-renderer'
 * await preloadMarkdown({ theme: lightTheme() })
 * ```
 */
export async function preloadMarkdown(options?: PreloadMarkdownOptions): Promise<void> {
    if (markedInstance) return
    let modules: [typeof import('marked'), typeof import('marked-terminal-renderer')]
    try {
        modules = await Promise.all([import('marked'), import('marked-terminal-renderer')])
    } catch (err) {
        if (err instanceof Error && 'code' in err && err.code === 'ERR_MODULE_NOT_FOUND') {
            throw new Error(
                "@doist/cli-core/markdown requires 'marked' and 'marked-terminal-renderer' as peer dependencies. " +
                    'Install them with: npm install marked marked-terminal-renderer',
                { cause: err },
            )
        }
        throw err
    }
    const [{ Marked }, { createTerminalRenderer, darkTheme }] = modules
    const instance = new Marked()
    instance.use(createTerminalRenderer(options?.theme ?? darkTheme()))
    markedInstance = instance
}

/**
 * Render a markdown string to ANSI-styled terminal output.
 *
 * Returns the input unchanged if `preloadMarkdown` has not yet run — keeps
 * call sites simple in code paths that may execute before init (e.g. early
 * errors). Trailing whitespace from the renderer is trimmed so callers can
 * `console.log` the result without a stray blank line.
 *
 * ```ts
 * import { preloadMarkdown, renderMarkdown } from '@doist/cli-core/markdown'
 *
 * await preloadMarkdown()
 * console.log(await renderMarkdown('# Title\n\n- one\n- two'))
 * ```
 */
export async function renderMarkdown(text: string): Promise<string> {
    if (!markedInstance) return text
    const rendered = await markedInstance.parse(text)
    return typeof rendered === 'string' ? rendered.trimEnd() : text
}
