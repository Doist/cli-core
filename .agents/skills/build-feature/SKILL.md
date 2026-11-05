---
name: build-feature
description: Builds a new module, export, option or behaviour in thin test-first slices, after settling the open decisions with the owner. Use when asked to "add", "build", "implement", "support" or "create" something, such as a new export, a new subpath or a new option on an existing helper.
---

# Build a feature

## 1. Read the closest existing feature

Find the module most like the one you are building and read it with its test: `src/auth/status.ts` for an attacher (`CODEBASE.md`, "Attacher pattern"), `src/options.ts` for a root helper, `src/extensions/manager.ts` for the extension system. Read `AGENTS.md` ("Module layout", "README maintenance"). Done when you can name the file you will copy patterns from.

## 2. Settle decisions in one round

List what the request leaves open: the export's name and which entry point carries it (`src/index.ts` or a subpath), its signature and options, error codes, whether it needs a peer dependency, and whether the change is additive or breaking for the CLIs that use it. Ask the owner all of them at once, each with your recommendation. Don't ask what the code can answer. Done when every decision has an answer.

## 3. Write "done" as checkable behaviours

Write each behaviour as a call and the expected result, for example: "`formatNdjson([1, undefined])` throws a `TypeError` naming index 1". Each becomes a test. Done when a test could pass or fail on every one.

## 4. Build in thin slices, test first

For each behaviour: write its test at the module's public interface, see it fail, make it pass, run its test file. Follow `write-tests`. Done when every behaviour from step 3 has a passing test you saw fail.

## 5. Update everything the change touches

| You changed                      | Also update                                                                                                                 |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Added or changed an export       | Its barrel (`src/index.ts` or the subpath's `index.ts`), and `README.md` ("What's in it" and the usage block)               |
| A new subpath                    | `package.json#exports` (`types` and `import`), its barrel, `README.md`, and the "Public API surface" table in `CODEBASE.md` |
| A peer dependency                | `peerDependencies` and `peerDependenciesMeta` in `package.json`, and the install notes in `README.md`                       |
| A new error code                 | The area's code union, folded into `CliErrorCode` (`src/errors.ts`)                                                         |
| The extension templates          | `templates/extension/`, and the shipped-templates suite in `src/extensions/create.test.ts`                                  |
| A helper consumers' tests use    | `src/testing/` and its barrel; it ships in the `./testing` subpath                                                          |
| Structure (new folder or module) | `CODEBASE.md`                                                                                                               |

Done when each row that applies is handled.

## 6. Verify and report

Follow `verify`. A change the CLIs will feel deserves one built against it: say which. If the feature needs restructuring first, do that as a separate change with `refactor`.
