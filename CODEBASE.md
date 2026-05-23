# CODEBASE.md — Repo Map

> **Purpose:** a ~2000-token orientation file so Claude (and humans) can navigate
> this repo without exploring. Describes _what is where_; `AGENTS.md` describes
> _how to change things_. Update when structure shifts, not on every new file.

## What this project is

`@doist/cli-core` is a **shared TypeScript library** for the three Doist CLIs
(`@doist/todoist-cli`, `@doist/twist-cli`, `@doist/outline-cli`). It is **not a
binary** — it ships reusable building blocks (error type, config I/O, output
formatters, spinner, OAuth/keyring auth runtime, Commander "attachers") that each
CLI composes into its own `program`.

ESM-only · Node ≥ 20.18.1 · Commander 14 (optional peer) · vitest · oxlint +
oxfmt (no eslint/prettier) · semantic-release on merge to `main`.

Heavy/optional deps are **optional peer-deps**, pulled in only by the subpath
that needs them (`commander`, `marked`, `marked-terminal-renderer`,
`oauth4webapi`, `open`, `@napi-rs/keyring`, `vitest`). Only `chalk` +
`yocto-spinner` are hard runtime deps.

## Top-level layout

```
/
├─ src/                   # All source. See tree below.
├─ dist/                  # Build output (tsc). Never edit.
├─ AGENTS.md              # Prescriptive rules (build, code style, README upkeep)
├─ CODEBASE.md            # This file — descriptive map
├─ CLAUDE.md              # One-liner forward to AGENTS.md
├─ README.md              # Public API docs ("What's in it" table + usage)
├─ tsconfig.json          # Includes src + tests (type-check, IDE)
├─ tsconfig.build.json    # Excludes *.test.ts + test-support/ + __mocks__/ (build/dev)
├─ vitest.config.ts       # { globals, root: 'src', include: ['**/*.test.ts'] }
├─ lefthook.yml           # Pre-commit: oxfmt + oxlint + type-check + test
└─ release.config.js      # semantic-release config
```

## Public API surface (`package.json#exports`)

Each subpath is an independent entry point so JSON-only consumers don't pay for
markdown/OAuth transitive installs.

| Subpath                    | Provides                                                                                                                            | Optional peers needed                                   |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `.` (root)                 | `CliError`, config I/O, JSON/NDJSON + `emitView`, `printEmpty`, spinner, terminal detection, global-args parser                     | — (chalk/yocto bundled)                                 |
| `@doist/cli-core/auth`     | OAuth runtime, the `attach*Command` registrars, providers, keyring `TokenStore`, refresh, the `TokenStore`/`AuthProvider` contracts | `commander`, `oauth4webapi`, `open`, `@napi-rs/keyring` |
| `@doist/cli-core/commands` | `registerChangelogCommand`, `registerUpdateCommand` + semver helpers                                                                | `commander`                                             |
| `@doist/cli-core/markdown` | `preloadMarkdown`, `renderMarkdown`                                                                                                 | `marked`, `marked-terminal-renderer`                    |
| `@doist/cli-core/testing`  | `describeEmptyMachineOutput` (public test helper for consumers)                                                                     | `vitest`                                                |

The public surface = every re-export through these entry barrels. `tsc --noEmit`
validates the re-exports; there is no separate runtime pinning test (per AGENTS.md).

## `src/` tree

```
src/
├─ index.ts               # Root barrel (the `.` export)
├─ errors.ts              # CliError<TCode> + CliErrorCode aggregator + getErrorMessage
├─ config.ts              # XDG config I/O; CoreConfig / UpdateChannel / ConfigErrorCode
├─ json.ts                # formatJson / formatNdjson (throw on non-serializable)
├─ options.ts             # ViewOptions type + emitView (json/ndjson/human dispatch)
├─ empty.ts               # printEmpty (machine-aware empty-state output)
├─ global-args.ts         # parseGlobalArgs + spinner/accessible gate factories + stripUserFlag
├─ spinner.ts             # createSpinner factory (yocto-spinner wrapper)
├─ terminal.ts            # isStdoutTTY / isStdinTTY / isStderrTTY / isCI
├─ markdown.ts            # ./markdown subpath (lazy marked + terminal renderer)
├─ testing.ts             # ./testing subpath (describeEmptyMachineOutput)
├─ auth/                  # ./auth subpath — see below
├─ commands/              # ./commands subpath (changelog, update + semver helpers)
└─ test-support/          # Internal test helpers — EXCLUDED from build, never shipped
   ├─ accounts.ts         # TestAccount fixtures (Ingen identities) + buildTokenStore / buildSingleEntryStore
   ├─ cli-harness.ts      # installConsoleLogSpy / installStdoutSpy / buildProgram
   └─ keyring-mocks.ts    # buildKeyringMap / buildSingleSlot / buildUserRecords
```

Every module has a colocated `<name>.test.ts` (31 test files). Subfolders
(`auth/`, `commands/`) follow the same colocated-test rule.

## `src/auth/` — the OAuth + token-storage subpath

```
auth/
├─ index.ts               # ./auth barrel
├─ types.ts               # CONTRACTS: AuthProvider, TokenStore<TAccount>, AuthAccount,
│                         #   TokenBundle, ActiveBundleSnapshot, ClearedAccount, AccountRef
├─ errors.ts              # AuthErrorCode union
├─ flow.ts                # runOAuthFlow() — PKCE callback-server flow end-to-end
├─ login.ts / logout.ts / status.ts / token-view.ts   # attach<X>Command registrars
├─ account.ts             # attachAccountList/Use/Current/Remove command registrars
├─ user-flag.ts           # INTERNAL: --user wiring, requireSnapshotForRef, accountNotFoundError
├─ pkce.ts                # PKCE primitives (verifier/challenge/state)
├─ persist.ts             # persistBundle / bundleFromExchange (setBundle-or-set fallback)
├─ refresh.ts             # refreshAccessToken (silent refresh w/ file lock)
├─ providers/
│  ├─ pkce.ts             # createPkceProvider (standard public-client PKCE)
│  ├─ dcr.ts              # createDcrProvider (RFC 7591 dynamic client registration)
│  └─ oauth.ts            # shared oauth4webapi glue
└─ keyring/               # OS-keyring-backed TokenStore
   ├─ index.ts            # barrel for the keyring exports
   ├─ secure-store.ts     # createSecureStore (thin @napi-rs/keyring wrapper)
   ├─ token-store.ts      # createKeyringTokenStore — the multi-account TokenStore impl
   ├─ record-write.ts     # bundle/token slot writes + fallback warnings
   ├─ migrate.ts          # migrateLegacyAuth (v1 plaintext → v2 keyring)
   ├─ slot-naming.ts      # keyring service/account slug rules
   ├─ internal.ts         # shared internals
   └─ types.ts            # UserRecord / UserRecordStore / SecureStore contracts
```

**Auth split:** cli-core owns the OAuth flow, keyring `TokenStore`, and the four
command registrars. A consuming CLI supplies (a) a `UserRecordStore` adapter over
its own config file and (b) a provider `validateToken` that maps the access token
to its account shape. See README "Auth (optional subpath)".

## Attacher pattern

`attach<X>Command(parent, options)` is the shared shape across login / logout /
status / token-view / account-list/use/current/remove:

- Attaches a subcommand to a `parent` Commander command, returns the new
  `Command` for chaining.
- Strips the registrar flags (`--json` / `--ndjson` / `--user`) and exposes the
  remainder to consumer callbacks as `flags`.
- Machine output: `--json` wins over `--ndjson`; renderers (`renderText` /
  `renderJson`) are consumer hooks, invoked only in the relevant mode.
- Errors throw `CliError` with an `AuthErrorCode`; the consumer's top-level
  handler renders it.

## The `TokenStore` contract (`auth/types.ts`)

The pivot type every auth helper is generic over. Multi-account-shaped:
`active(ref?)`, `set`, `clear(ref?) → ClearedAccount`, `list()`, `setDefault(ref)`,
plus optional `activeAccount` / `activeBundle` / `setBundle` (refresh + `current`
fast-path). Effective default = pinned default if present, else the sole stored
account. `createKeyringTokenStore` is the shipped impl; CLIs may provide their own.

## `src/test-support/` — internal test helpers (never shipped)

Excluded from `dist/` by `tsconfig.build.json` and not matched by vitest's
`**/*.test.ts` include, so these files run as helpers, not suites.

- **`accounts.ts`** — `TestAccount` type + Ingen fixtures (`alanGrant` id 1,
  `ellieSattler` 2, `ianMalcolm` 3); `buildTokenStore()` — the canonical stateful
  multi-account `TokenStore` mock (mirrors `createKeyringTokenStore`'s
  effective-default + promote-if-unpinned + slot-replacement semantics);
  `buildSingleEntryStore()` for the single-account suites; `ingenEntries()` default seed.
- **`cli-harness.ts`** — `installConsoleLogSpy()` / `installStdoutSpy()` (own the
  beforeEach/afterEach spy lifecycle, return a getter) + `buildProgram(name)`
  (the `new Command().exitOverride().command(name)` scaffold).
- **`keyring-mocks.ts`** — `buildKeyringMap` / `buildSingleSlot` /
  `buildUserRecords` for the keyring unit suites.

## Testing

- **Runner:** vitest. `npm test` (one-shot), `npm run test:watch`.
- **Location:** colocated `*.test.ts` next to the module under test.
- **Account suites:** import fixtures + `buildTokenStore` / `buildSingleEntryStore`
  from `test-support/accounts.js` and the spy/scaffold helpers from
  `test-support/cli-harness.js` — do NOT hand-roll account objects or store mocks.
- **Pattern:** `const logSpy = installConsoleLogSpy()` at the top of a `describe`,
  build via `buildProgram('auth'|'account')`, drive with
  `program.parseAsync(['node','cli',…])`.
- No `restoreMocks` in config — the helpers restore their own spies.

## Build & release

- **Build:** `tsc -p tsconfig.build.json` → `dist/`. Two-tsconfig setup:
  `tsconfig.json` includes tests (type-check/IDE); `tsconfig.build.json` excludes
  `*.test.ts` + `src/test-support/` so test-only code never ships.
- **Type-check:** `npm run type-check` (`tsc --noEmit`).
- **Lint/format:** `npm run check` (`oxlint src && oxfmt --check`), `npm run fix`.
  **No ESLint, no Prettier.** `npm run check` is the gate — run before a PR.
- **Release:** semantic-release on merge to `main`; Conventional Commits required.
  `next` is the pre-release branch.

## Conventions (quick)

- Prefer `type` over `interface` for object shapes (per AGENTS.md).
- No dead exports — anything not reached from an entry barrel or a test is deleted.
- New/renamed/removed public export ⇒ update `README.md` in the same commit
  (the "What's in it" table + affected usage block) — AGENTS.md "README maintenance".
- Errors: `new CliError(code, message, { hints? })`; codes come from the
  per-area unions folded into `CliErrorCode`.
- Status glyphs (`✓`/`✗`) allowed in user-facing output; otherwise no emojis.

## Start here if new

1. `README.md` — the public API, with usage blocks per subpath.
2. `src/index.ts` + `src/options.ts` — the root building blocks (`emitView`, `CliError`).
3. `src/auth/types.ts` — the `TokenStore` / `AuthProvider` contracts everything is generic over.
4. `src/auth/status.ts` — canonical attacher; `src/auth/flow.ts` — the OAuth runtime.
5. `src/test-support/accounts.ts` — the shared test harness.
6. `AGENTS.md` — rules you must follow.
