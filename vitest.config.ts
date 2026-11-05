process.env.TZ = 'UTC'

import { defineConfig } from 'vitest/config'
import { clearGitEnv } from './.agents/scripts/lib/git.ts'

// `npm test` runs inside the pre-push hook, and git exports GIT_DIR and friends to hooks (from a
// linked worktree, at least). Left in place, the git commands the extension tests run would act on
// this repository instead of their temp ones. Workers inherit this process's environment.
clearGitEnv()

export default defineConfig({
    test: {
        globals: true,
        root: 'src',
        // The agent tooling's tests live outside `root`, next to the tooling.
        include: ['**/*.test.ts', '../.agents/scripts/**/*.test.ts'],
        restoreMocks: true,
    },
})
