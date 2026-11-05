# cli-core

Shared core utilities for the Doist CLIs (`@doist/todoist-cli`, `@doist/twist-cli`, `@doist/outline-cli`, `@doist/comms-cli`). TypeScript, ESM-only, Node ≥ 24.

## Definition of done

- **Done means proven:** a test that failed before the change and passes after, at the module's public interface. For a refactor: tests that pin the behaviour, passing before and after. Reading code or a passing compile is not proof.
- **Run `npm run verify` before calling a change done.** It runs every check CI runs, in about five seconds, and records the pass. It prints what it cannot see, and when only docs changed it checks just their formatting.
- **Never weaken a check to pass it.** Don't skip, delete or loosen tests, edit lint, type or test config to get green, or use `--no-verify`. If a check looks wrong, say so and stop.
- **Report honestly:** what ran, what it showed, and what you did not verify.

## Skills

Use the matching skill without being asked. They live in `.agents/skills/` (Claude Code reads them through `.claude/skills/`).

- `verify`: before saying a change is done, fixed or ready.
- `fix-bug`: something is broken or wrong.
- `build-feature`: a new module, export, option or behaviour.
- `refactor`: changing structure without changing behaviour. Other tasks send restructuring here, as a separate change.
- `write-tests`: writing or changing tests; `.agents/skills/write-tests/references/test-rules.md` is the quality bar.
- `learn`: after a correction, to turn it into a check.
- `review-changes`: when the owner says a change is ready for a PR, or asks for a review.

## Review checks

Reviewers, Doistbot included, apply these to every change:

- [Tests](.agents/checks/tests.md): not weakened, new behaviour tested.
- [Architecture](.agents/checks/architecture.md): rules lint can't express.
- [Security](.agents/checks/security.md): tokens, OAuth, the keyring, extensions.
- [Privacy and secrets](.agents/checks/privacy.md): this repository is public.
- [Public API](.agents/checks/public-api.md): what the Doist CLIs see.
- [Evidence](.agents/checks/evidence.md): claims backed by what ran.

## Build & Run

```bash
npm run build       # compile TypeScript to dist/
npm run dev         # watch mode
npm run type-check  # tsc --noEmit for src/ and the agent tooling (.agents/scripts)
npm run check       # oxlint + oxfmt --check
npm run fix         # oxlint --fix + oxfmt
npm test            # vitest run
npm run verify      # every check CI runs (lint, format, types, build, tests)
```

`npm run verify` is the gate — run it before opening a PR. It includes `npm run check`, which reads the whole tree: the local pre-commit hook only formats _staged_ files, so it can't catch a pre-existing off-format file.

## Git hooks and agent tooling

- Commits and pushes to `main` are refused by the git hooks. Work on a branch.
- Agent tooling lives in `.agents/scripts/`. It never ships: `package.json#files` lists only `dist`, `templates` and `CHANGELOG.md`, and a test checks the packed tarball.
- How it all fits together: [`docs/agents.md`](docs/agents.md).

## Code style

- **Prefer `type` over `interface`.** Use `type` aliases for every object-shape declaration we own. `interface` is reserved for the rare case where declaration merging is genuinely needed (none today). `class X implements MyType` works fine for object-shape `type`s, so the constraint doesn't cost anything.
- **No emojis in source files** unless explicitly requested. Status glyphs (`✓` / `✗`) used in spinner output are exceptions because they're user-facing.
- **No comments that restate the code.** Comments earn their place by explaining _why_ — non-obvious constraints, invariants, edge cases, or workarounds.
- **No dead exports.** If something isn't reached from `src/index.ts` (or a test), delete it.

## Module layout

Each module lives at `src/<area>.ts` with a colocated `<area>.test.ts`. A module that needs sibling files (e.g. the `./commands` subpath) lives at `src/<area>/<file>.ts` with the same colocated-test rule. Public API surface is the union of every `export` re-exported through `src/index.ts` plus any sub-path entry declared in `package.json#exports` (e.g. `./commands`, `./extensions`, `./markdown`, `./testing`). Non-code assets that ship with the package (the extension scaffold templates) live under `templates/`, are listed in `package.json#files`, and are resolved from `import.meta.url` two levels up so the same path works from `src/` under vitest and from `dist/` when installed. Re-exports are validated at compile time by `tsc --noEmit` — there is no parallel runtime/typed-literal pinning test for the package root, since the typechecker already catches a dropped or broken re-export and any duplicate runtime suite would be redundant churn.

## README maintenance

`README.md` documents the public API. When a commit adds, removes, or meaningfully changes that surface, update the README in the same commit. Specifically:

- a new module under `src/` that's reachable from `src/index.ts` or a sub-path export
- a new, renamed, or removed export from `src/index.ts` or a sub-path entry
- a new sub-path export in `package.json#exports`
- a change to peer-dep requirements, install steps, or supported Node version

The "What's in it" table and any usage block touching the affected module must reflect the change before the PR lands. Internal refactors, bug fixes, and doc-only edits don't need a README update.

## Releases

Pushes to `main` trigger semantic-release with conventional-commits + npm provenance. `next` is the pre-release branch. The auto-release workflow is gated by branch in `release.yml`; do not enable broader triggers.
