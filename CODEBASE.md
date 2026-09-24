# CODEBASE.md — Repo Map

> **Purpose:** a ~2000-token orientation file so Claude (and humans) can navigate
> this repo without exploring. Describes _what is where_; `AGENTS.md` describes
> _how to change things_. Update when structure shifts, not on every new file.

## What this project is

`@doist/cli-core` is a **shared TypeScript library** for the Doist CLIs
(`@doist/todoist-cli`, `@doist/twist-cli`, `@doist/outline-cli`,
`@doist/comms-cli`). It is **not a binary** — it ships reusable building blocks
(error type, config I/O, output formatters, spinner, OAuth/keyring auth runtime,
Commander "attachers", the extension system) that each CLI composes into its own
`program`.

ESM-only · Node ≥ 24 · Commander ≥ 14 (optional peer) · vitest · oxlint +
oxfmt (no eslint/prettier) · semantic-release on merge to `main`.

Heavy/optional deps are **optional peer-deps**, pulled in only by the subpath
that needs them (`commander`, `marked`, `marked-terminal-renderer`,
`oauth4webapi`, `open`, `@napi-rs/keyring`, `vitest`, `zod`). Only `chalk` +
`yocto-spinner` are hard runtime deps.

## Top-level layout

```
/
├─ src/                   # All source. See tree below.
├─ templates/             # Extension scaffold templates, shipped as files (see `files`)
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

| Subpath                      | Provides                                                                                                                                             | Optional peers needed                                   |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `.` (root)                   | `CliError`, config I/O, data/state dirs, JSON/NDJSON + `emitView`, `printEmpty`, spinner, terminal detection, global-args parser, command-token scan | — (chalk/yocto bundled)                                 |
| `@doist/cli-core/auth`       | OAuth runtime, the `attach*Command` registrars, providers, keyring `TokenStore`, refresh, the `TokenStore`/`AuthProvider` contracts                  | `commander`, `oauth4webapi`, `open`, `@napi-rs/keyring` |
| `@doist/cli-core/commands`   | `registerChangelogCommand`, `registerUpdateCommand` + semver helpers                                                                                 | `commander`                                             |
| `@doist/cli-core/extensions` | `createExtensionManager`, `registerExtension*` registrars, `createExtension` scaffolding, doctor helpers                                             | `commander`, `zod`                                      |
| `@doist/cli-core/markdown`   | `preloadMarkdown`, `renderMarkdown`                                                                                                                  | `marked`, `marked-terminal-renderer`                    |
| `@doist/cli-core/testing`    | `describeEmptyMachineOutput`, `createTestProgram`, console captures, account fixtures, extension fixtures                                            | `vitest`, `commander`                                   |

The public surface = every re-export through these entry barrels. `tsc --noEmit`
validates the re-exports; there is no separate runtime pinning test (per AGENTS.md).

## `src/` tree

```
src/
├─ index.ts               # Root barrel (the `.` export)
├─ errors.ts              # CliError<TCode> + CliErrorCode aggregator + getErrorMessage
├─ config.ts              # XDG config I/O; CoreConfig / UpdateChannel / ConfigErrorCode
├─ paths.ts               # getDataDir / getStateDir (XDG data + state, Windows LOCALAPPDATA)
├─ command-token.ts       # findCommandToken / needsExtensionLookup (argv scan before commander)
├─ json.ts                # formatJson / formatNdjson (throw on non-serializable)
├─ options.ts             # ViewOptions type + emitView (json/ndjson/human dispatch)
├─ empty.ts               # printEmpty (machine-aware empty-state output)
├─ global-args.ts         # parseGlobalArgs + spinner/accessible gate factories + stripUserFlag
├─ spinner.ts             # createSpinner factory (yocto-spinner wrapper)
├─ terminal.ts            # isStdoutTTY / isStdinTTY / isStderrTTY / isCI
├─ markdown.ts            # ./markdown subpath (lazy marked + terminal renderer)
├─ testing/               # ./testing subpath — shipped helpers for consumers' tests
│  ├─ accounts.ts         # TestAccount fixtures (Ingen identities) + buildTokenStore / buildSingleEntryStore
│  ├─ console.ts          # captureConsole / captureStream
│  ├─ empty-output.ts     # describeEmptyMachineOutput
│  ├─ extensions.ts       # writeFixtureExtension / writeFakeGitRepo (a runnable extension on disk)
│  └─ program.ts          # createTestProgram
├─ auth/                  # ./auth subpath — see below
├─ commands/              # ./commands subpath (changelog, update + semver helpers)
├─ extensions/            # ./extensions subpath — see below
└─ test-support/          # Internal test helpers — EXCLUDED from build, never shipped
   ├─ cli-harness.ts      # installCapturedConsole / installCapturedStream / buildProgram
   ├─ keyring-mocks.ts    # buildKeyringMap / buildSingleSlot / buildUserRecords
   └─ refresh-fixtures.ts # shared refresh-token fixtures
```

Every module has a colocated `<name>.test.ts` (55 test files). Subfolders
(`auth/`, `commands/`, `extensions/`) follow the same colocated-test rule.

## `src/extensions/` — the extension-system subpath

```
extensions/
├─ index.ts               # ./extensions barrel
├─ types.ts               # ExtensionManagerOptions (the whole host contract), Extension, results
├─ manager.ts             # createExtensionManager — facade over everything below
├─ commands.ts            # registerExtensionGroup / registerExtensionPassThrough / registerExtensionCommands
├─ discover.ts            # Directory scan: kind inference (binary/git/local), manifests, state
├─ dispatch.ts            # buildExtensionEnv + spawn with inherited stdio, exit-code mapping
├─ install.ts / upgrade.ts / remove.ts   # The three lifecycle operations
├─ create.ts              # Scaffolding from templates/extension/ (defaultTemplatesDir)
├─ source.ts              # Naming rules (<bin>-<name>) + install-source parsing
├─ manifest.ts / manifest-format.ts / schemas.ts / schemas-loader.ts
│                         # Authored + installed manifests; zod lives only in schemas.ts,
│                         # reached through loadSchemas (friendly error when zod is missing)
├─ state.ts               # <stateDir>/extensions/<dir>.json (pins, update checks)
├─ github.ts / git.ts / npm.ts / run.ts  # Release assets + checksums, git, npm, captured spawn
├─ errors.ts              # ExtensionErrorCode union (folded into CliErrorCode)
└─ version-range.ts / concurrency.ts / json-file.ts / fs-utils.ts   # Small helpers
```

Nothing in here knows which CLI it serves: the binary name, env prefix,
directories, version, reserved names and first-party source all arrive through
`ExtensionManagerOptions`. `templates/extension/` is shipped as real files and
resolved from `import.meta.url` two levels up, so `src/` and `dist/` agree.

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

## `src/testing/` and `src/test-support/`

`src/testing/` is the shipped `./testing` subpath: what consuming CLIs import in
their own suites.

- **`accounts.ts`** — `TestAccount` type + Ingen fixtures (`alanGrant` id 1,
  `ellieSattler` 2, `ianMalcolm` 3); `buildTokenStore()` — the canonical stateful
  multi-account `TokenStore` mock (mirrors `createKeyringTokenStore`'s
  effective-default + promote-if-unpinned + slot-replacement semantics);
  `buildSingleEntryStore()` for the single-account suites; `ingenEntries()` default seed.
- **`console.ts`** — `captureConsole()` / `captureStream()` (silence + auto-restore
  via `onTestFinished`).
- **`program.ts`** — `createTestProgram(register)` (the `new Command().exitOverride()` scaffold).
- **`extensions.ts`** — `writeFixtureExtension()` / `writeFakeGitRepo()`: a real
  executable on disk that reports its argv and `<PREFIX>_*` env as JSON, because
  the extension contract is a process boundary and can only be proven by spawning.

`src/test-support/` is internal: excluded from `dist/` by `tsconfig.build.json`
and not matched by vitest's `**/*.test.ts` include, so these files run as
helpers, not suites.

- **`cli-harness.ts`** — `installCapturedConsole()` / `installCapturedStream()` (own the
  beforeEach/afterEach spy lifecycle, return a getter) + `buildProgram(name)`.
- **`keyring-mocks.ts`** — `buildKeyringMap` / `buildSingleSlot` /
  `buildUserRecords` for the keyring unit suites.
- **`refresh-fixtures.ts`** — shared fixtures for the refresh-token suites.

## Testing

- **Runner:** vitest. `npm test` (one-shot), `npm run test:watch`.
- **Location:** colocated `*.test.ts` next to the module under test.
- **Account suites:** import fixtures + `buildTokenStore` / `buildSingleEntryStore`
  from `testing/accounts.js` and the spy/scaffold helpers from
  `test-support/cli-harness.js` — do NOT hand-roll account objects or store mocks.
- **Pattern:** `const logSpy = installCapturedConsole()` at the top of a `describe`,
  build via `buildProgram('auth'|'account')`, drive with
  `program.parseAsync(['node','cli',…])`.
- **Extension suites:** real temp dirs (`mkdtemp`, resolved through `realpath` so
  macOS's `/var` → `/private/var` link cannot skew path assertions), a fake `npm`
  on `PATH`, `git` where available (`describe.skipIf(!HAS_GIT)`), and a stubbed
  `fetch` for GitHub.
- `restoreMocks: true` in config, so a `vi.spyOn` never leaks past its test; the
  console helpers also restore themselves.

## Build & release

- **Build:** `tsc -p tsconfig.build.json` → `dist/`. Two-tsconfig setup:
  `tsconfig.json` includes tests (type-check/IDE); `tsconfig.build.json` excludes
  `*.test.ts` + `src/test-support/` so test-only code never ships.
  `templates/` is not compiled: it is listed in `package.json#files` and read at
  run time.
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
5. `src/testing/accounts.ts` — the shared test harness.
6. `src/extensions/types.ts` — `ExtensionManagerOptions`, the whole host contract for extensions.
7. `AGENTS.md` — rules you must follow.
