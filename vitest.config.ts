process.env.TZ = 'UTC'

import { spawnSync } from 'node:child_process'
import { defineConfig } from 'vitest/config'

// `npm test` runs inside the pre-push hook, and git exports GIT_DIR and friends to hooks (from a
// linked worktree, at least). Left in place, the git commands the extension tests run would act on
// this repository instead of their temp ones. Workers inherit this process's environment.
const gitVars =
    spawnSync('git', ['rev-parse', '--local-env-vars'], { encoding: 'utf8' }).stdout ?? ''
for (const name of gitVars.split('\n').filter(Boolean)) delete process.env[name]

export default defineConfig({
    test: {
        globals: true,
        root: 'src',
        // The agent tooling's tests live outside `root`, next to the tooling.
        include: ['**/*.test.ts', '../.agents/scripts/**/*.test.ts'],
        restoreMocks: true,
    },
})
