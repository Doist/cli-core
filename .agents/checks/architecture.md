# Check: architecture

Rules lint and types can't express. Most are written in `AGENTS.md` and `CODEBASE.md`; report where a change works around one.

## Report

- An export not reached from its barrel (`src/index.ts` or the subpath's `index.ts`), a new subpath without its `package.json#exports` entry (`types` and `import`), or a dead export: one nothing re-exports or tests.
- A public export added, renamed, removed or meaningfully changed without the `README.md` update in the same change ("README maintenance" in `AGENTS.md`).
- A new runtime dependency (only `chalk` and `yocto-spinner` are), or an optional peer (any of `peerDependencies`: `commander`, `marked`, `marked-terminal-renderer`, `oauth4webapi`, `open`, `vitest`, `zod`) imported from the root entry, which would make every CLI install it.
- An error thrown as a bare `Error` where callers need a `CliError` code, or a new code missing from its area's union in `CliErrorCode`.
- `interface` for an object shape we own, where a `type` alias would do.
- Shipped templates resolved any other way than from `import.meta.url`, two levels up ("Module layout" in `AGENTS.md`).
- A helper that duplicates one elsewhere in `src/`.

## Fine

- An exception documented next to the code, with the reason.
- A new module or subpath added to `CODEBASE.md` in the same change.
