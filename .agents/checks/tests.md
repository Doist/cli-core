# Check: tests

Apply to every change that touches code or tests. The quality bar is `.agents/skills/write-tests/references/test-rules.md`.

## Report

- A test deleted, skipped (`.skip`, `.todo`, `xit`), or with an assertion loosened (`toEqual` → `toMatchObject`, exact arguments → `toHaveBeenCalled()`, an exact string → `stringContaining`), without a behaviour change that explains it.
- A new snapshot test, or fake timers where a short real wait or `vi.waitFor` is the pattern here.
- New behaviour with no test, or a test that would still pass with the change undone.
- A new `vi.mock` of an internal module that holds logic, or a mock of the function under test.
- An expected value computed by the code under test.
- A test that touches the real home directory, keyring or network instead of a temp directory, the keyring mocks or a `fetchImpl`.
- Config that runs fewer tests: `vitest.config.ts` `include`/`exclude`, the scripts in `package.json`, the steps in `.github/workflows/test.yml`.

## Fine

- `.not.toHaveBeenCalled()`, guards like `toBeDefined()` before reading a value, real temp directories and child processes, as the test rules describe.
- A test changing its assertions because the behaviour changed on purpose, when the description says so.
- A refactor changing import paths, names or call sites in tests.
