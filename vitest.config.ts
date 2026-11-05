process.env.TZ = 'UTC'

import { defineConfig } from 'vitest/config'

export default defineConfig({
    test: {
        globals: true,
        root: 'src',
        // The agent tooling's tests live outside `root`, next to the tooling.
        include: ['**/*.test.ts', '../.agents/scripts/**/*.test.ts'],
        restoreMocks: true,
    },
})
