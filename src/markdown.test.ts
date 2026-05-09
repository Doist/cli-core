import { beforeEach, describe, expect, it, vi } from 'vitest'

async function loadFresh() {
    vi.resetModules()
    return await import('./markdown.js')
}

describe('renderMarkdown', () => {
    beforeEach(() => {
        vi.resetModules()
    })

    it('returns input unchanged when not preloaded', async () => {
        const { renderMarkdown } = await loadFresh()
        expect(await renderMarkdown('# Title')).toBe('# Title')
    })

    it('renders markdown after preload', async () => {
        const { preloadMarkdown, renderMarkdown } = await loadFresh()
        await preloadMarkdown()
        const out = await renderMarkdown('# Title')
        expect(out.length).toBeGreaterThan(0)
        expect(out).not.toBe('# Title')
        expect(out).toContain('Title')
    })

    it('trims trailing whitespace from renderer output', async () => {
        const { preloadMarkdown, renderMarkdown } = await loadFresh()
        await preloadMarkdown()
        const out = await renderMarkdown('hello world')
        expect(out).toBe(out.trimEnd())
    })
})

describe('preloadMarkdown', () => {
    beforeEach(() => {
        vi.resetModules()
    })

    it('is idempotent — second call resolves without throwing', async () => {
        const { preloadMarkdown } = await loadFresh()
        await preloadMarkdown()
        await expect(preloadMarkdown()).resolves.toBeUndefined()
    })

    it('accepts a custom theme', async () => {
        const { lightTheme, preloadMarkdown, renderMarkdown } = await loadFresh()
        await preloadMarkdown({ theme: lightTheme() })
        const out = await renderMarkdown('**bold**')
        expect(out.length).toBeGreaterThan(0)
        expect(out).toContain('bold')
    })
})
