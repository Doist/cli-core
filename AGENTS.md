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

Each module lives at `src/<area>.ts` with a colocated `<area>.test.ts`. Public API surface is the union of every `export` re-exported through `src/index.ts`. `src/index.test.ts` pins those re-exports — type-only re-exports get anchored via typed literal assignments because they're erased at runtime.

## Releases

Pushes to `main` trigger semantic-release with conventional-commits + npm provenance. `next` is the pre-release branch. The auto-release workflow is gated by branch in `release.yml`; do not enable broader triggers.
