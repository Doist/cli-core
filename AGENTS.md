# cli-core

Shared core utilities for the Doist CLIs (`@doist/todoist-cli`, `@doist/twist-cli`, `@doist/outline-cli`). TypeScript, ESM-only, Node ≥ 20.18.1.

## Build & Run

```bash
npm run build       # compile TypeScript to dist/
npm run dev         # watch mode
npm run type-check  # tsc --noEmit
npm run check       # oxlint + oxfmt --check
npm run fix         # oxlint --fix + oxfmt
npm test            # vitest run
```

`npm run check` is the gate — run it before opening a PR. The local pre-commit hook only formats _staged_ files, so it can't catch a pre-existing off-format file (e.g. an auto-generated `CHANGELOG.md` after a release).

## Code style

- **Prefer `type` over `interface`.** Use `type` aliases for every object-shape declaration we own. `interface` is reserved for the rare case where declaration merging is genuinely needed (none today). `class X implements MyType` works fine for object-shape `type`s, so the constraint doesn't cost anything.
- **No emojis in source files** unless explicitly requested. Status glyphs (`✓` / `✗`) used in spinner output are exceptions because they're user-facing.
- **No comments that restate the code.** Comments earn their place by explaining _why_ — non-obvious constraints, invariants, edge cases, or workarounds.
- **No dead exports.** If something isn't reached from `src/index.ts` (or a test), delete it.

## Module layout

Each module lives at `src/<area>.ts` with a colocated `<area>.test.ts`. A module that needs sibling files (e.g. the `./commands` subpath) lives at `src/<area>/<file>.ts` with the same colocated-test rule. Public API surface is the union of every `export` re-exported through `src/index.ts` plus any sub-path entry declared in `package.json#exports` (e.g. `./commands`, `./markdown`, `./testing`). Re-exports are validated at compile time by `tsc --noEmit` — there is no parallel runtime/typed-literal pinning test for the package root, since the typechecker already catches a dropped or broken re-export and any duplicate runtime suite would be redundant churn.

## README maintenance

`README.md` documents the public API. When a commit adds, removes, or meaningfully changes that surface, update the README in the same commit. Specifically:

- a new module under `src/` that's reachable from `src/index.ts` or a sub-path export
- a new, renamed, or removed export from `src/index.ts` or a sub-path entry
- a new sub-path export in `package.json#exports`
- a change to peer-dep requirements, install steps, or supported Node version

The "What's in it" table and any usage block touching the affected module must reflect the change before the PR lands. Internal refactors, bug fixes, and doc-only edits don't need a README update.

## Releases

Pushes to `main` trigger semantic-release with conventional-commits + npm provenance. `next` is the pre-release branch. The auto-release workflow is gated by branch in `release.yml`; do not enable broader triggers.
