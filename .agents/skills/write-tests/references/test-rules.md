# Test rules

Calibrated on this repository's tests (about 820 in `src/`, November 2026). Each rule says what to flag and what is fine, because a rule that flags good tests teaches agents to damage them.

## 1. It can fail

You saw the test fail once: before the fix, or with the feature undone. A test that has never failed may be testing nothing.

## 2. It asserts outcomes

Assert what the caller gets or what reaches the boundary: the returned value, `toHaveBeenCalledWith(<exact args>)`, the exact output line, the error code. Flag an assertion that cannot tell right from wrong.

| Flag                                                                                                 | Fine                                                                                                                                                                                                              |
| ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `toHaveBeenCalled()` as the only evidence the behaviour happened: nothing checks arguments or output | `toHaveBeenCalled()` next to assertions on the arguments or output (`src/commands/update.test.ts:276`), or as the sync point inside `vi.waitFor`                                                                  |
|                                                                                                      | `.not.toHaveBeenCalled()`: proves a call did **not** happen (about 100 here, e.g. a rejected callback port never opens the browser, `src/auth/flow.test.ts:235`)                                                  |
| `toBeDefined()` / `toBeTruthy()` as the last word on a value                                         | The same as a guard right before reading the value's fields (`src/testing/subpath.test.ts:14`); `stat(path)` `resolves.toBeTruthy()` when the file existing **is** the point (`src/extensions/remove.test.ts:74`) |
| A test whose only assertion is that no error was thrown, when the behaviour is a result              | `resolves.not.toThrow()` when accepting the input **is** the behaviour                                                                                                                                            |

Judge a test by its point, the behaviour its name describes. A weak assertion beside the ones that carry that point is fine.

## 3. Expected values come from outside the code under test

Write the expected value out as literals (a lookup table or `it.each` rows are fine), or build it from the account fixtures. Flag an expectation that calls the code under test, or recomputes the answer the way the code does.

## 4. Mock only real boundaries

The boundaries here: the file system and OS (`node:fs`, `node:fs/promises`, `node:os`, `node:child_process`), the keyring (`@napi-rs/keyring`, `src/auth/keyring/secure-store.test.ts:27`), the browser (`open`, `src/auth/flow.test.ts:19`), optional peers (`oauth4webapi` via `vi.doMock` to simulate it missing), the network (a `fetchImpl` option, or `vi.stubGlobal('fetch')`), and environment variables (`vi.stubEnv`). Real temp directories, real child processes and a real callback server on an ephemeral port are fine and common.

| Flag                                                                             | Fine                                                                                                                                                                                                                                |
| -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A **new** `vi.mock` of an internal module that holds logic, to make setup easier | The boundaries above; the keyring adapter seam (`./secure-store.js`) and `./npm.js`, which wrap the keyring and a real npm run. Existing one-offs (`src/auth/login.test.ts:10` mocks `./flow.js`): tolerated, not a pattern to copy |
| Mocking the function the test is about, or one that computes its expected value  |                                                                                                                                                                                                                                     |

## 5. No skipped or focused tests

None exist. `.only` fails in CI (`CI=true`, which `npm run verify` sets too). Don't add `.skip`, `.todo` or `xit` to get green. Fine: `skipIf`/`runIf` for a platform, a missing tool (`git`) or a missing build, with the reason in a comment (`src/extensions/npm.test.ts:15`, `src/testing/subpath.test.ts:22`).

## 6. Short, purposeful waits only

There are no fake timers here. Fine: a short real wait that interleaves concurrent work so the test can check ordering or limits (`src/extensions/concurrency.test.ts:15`), a simulated lock holder (`src/auth/refresh.test.ts:206`), or a real timeout under test kept small. Flag a long sleep that only hopes something has finished; wait on the event or use `vi.waitFor`.

## 7. No snapshots

None exist: tests assert exact values and output strings. Keep it that way. A new snapshot records whatever the output is the first time it runs, so it proves nothing about what it should be.

## 8. Reading source files is for contracts

Fine: a test that reads source, config or shipped files to enforce a rule across the package (`src/testing/subpath.test.ts` reads `package.json#exports`; the shipped-templates suite in `src/extensions/create.test.ts:221` reads `templates/`). Flag a test that reads a source file to check one function's behaviour; call the function instead.

## 9. No real user data

Fixtures use cli-core's fictional accounts (`alanGrant`, `ellieSattler`, `ianMalcolm`) and `example.com`. This repository is public, and `src/testing/` ships to every CLI.
