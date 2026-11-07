---
name: write-tests
description: Writes or changes tests in this repository to its quality bar, with the right helpers and layer. Use when adding, fixing or reviewing tests, when a change "needs a test", or when deciding whether a test may change.
---

# Write tests

## Where tests live

- Next to the code: `src/json.ts` → `src/json.test.ts`, `src/auth/status.ts` → `src/auth/status.test.ts`. Vitest, globals on, `restoreMocks: true` (spies restore themselves), `TZ=UTC`.
- Tests import the module under test directly, not through `src/index.ts` or a subpath barrel. The barrels are checked by the type check, and the built `./testing` entry by `src/testing/subpath.test.ts`.
- Registrar and attacher suites build a program with `buildProgram('auth')` and drive it with `program.parseAsync(['node', 'cli', ...])` (see `src/auth/status.test.ts`).
- Extension suites work in real temp directories (`mkdtemp`, resolved through `realpath`) removed in `afterEach`, with fixture extensions written by `writeFixtureExtension`; suites that need `git` skip without it.
- Agent tooling tests live in `.agents/scripts/` and run copies of the tools in throwaway repos (`.agents/scripts/lib/test-repo.ts`).

## Helpers

From `src/test-support/` (internal, never shipped): `buildProgram`, `installCapturedConsole`, `installCapturedStream`, `buildKeyringMap`, `buildSingleSlot`, `buildUserRecords`, `installLockPath`, `expiringBundle`, `expiredBundle`, `buildBundleStore`, `fakeRefreshProvider`. From `src/testing/` (the public `./testing` subpath, which the CLIs use too): `alanGrant`, `ellieSattler`, `ianMalcolm`, `buildTokenStore`, `buildSingleEntryStore`, `captureConsole`, `captureStream`, `createTestProgram`, `mockStdin`, `describeEmptyMachineOutput`, `writeFixtureExtension`, `writeFakeGitRepo`. Use them instead of hand-rolling accounts, stores or console spies. A change to a `src/testing/` helper changes the CLIs' tests too.

## The quality bar

Read [references/test-rules.md](references/test-rules.md) before writing or reviewing a test. In short: a test counts only if it can fail. It asserts outcomes, takes expected values from outside the code under test, mocks only real boundaries, and you saw it fail once.

Done when each new test has failed once for the right reason, and then passes.

## When an existing test may change

- **The behaviour changed on purpose** (a feature or a fix): change the assertions that describe it, and say which in the report.
- **A refactor:** only how the test reaches the code (imports, names, call sites). Never its inputs or assertions, including expected output strings.
- **Never** to make a failing check pass without a behaviour change: no `.skip`, no deleted test, no looser matcher (`toEqual` → `toMatchObject`, exact arguments → `toHaveBeenCalled()`).
