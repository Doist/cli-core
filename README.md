# @doist/cli-core

Shared core utilities for Doist CLI projects ([todoist-cli](https://github.com/Doist/todoist-cli), [twist-cli](https://github.com/Doist/twist-cli), [outline-cli](https://github.com/Doist/outline-cli)).

TypeScript, ESM-only, Node ≥ 20.18.1.

## Install

```bash
npm install @doist/cli-core
```

## What's in it

| Module               | Key exports                                                                                                                                                     | Purpose                                                                                                                                                                                                                                                                                                                                                                                   |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `auth` (subpath)     | `registerAuthCommand`, `runOAuthFlow`, `startCallbackServer`, `createPkceProvider`, `createConfigTokenStore`, PKCE helpers, `AuthProvider` / `TokenStore` types | OAuth runtime plus the `registerAuthCommand` Commander registrar for `<cli> [auth] login`. Ships the standard public-client PKCE flow + single-user config-backed token store; the `AuthProvider` and `TokenStore` interfaces are the escape hatches for DCR, OS-keychain, multi-account, etc. `commander` (when using the registrar) and `open` (browser launch) are optional peer-deps. |
| `commands` (subpath) | `registerChangelogCommand`, `registerUpdateCommand` (+ semver helpers)                                                                                          | Commander wiring for cli-core's standard commands (e.g. `<cli> changelog`, `<cli> update`, `<cli> update switch`). **Requires** `commander` as an optional peer-dep.                                                                                                                                                                                                                      |
| `config`             | `getConfigPath`, `readConfig`, `readConfigStrict`, `writeConfig`, `updateConfig`, `CoreConfig`, `UpdateChannel`                                                 | Read / write a per-CLI JSON config file with typed error codes; `CoreConfig` is the shape of fields cli-core itself owns (extend it for per-CLI fields).                                                                                                                                                                                                                                  |
| `empty`              | `printEmpty`                                                                                                                                                    | Print an empty-state message gated on `--json` / `--ndjson` so machine consumers never see human strings on stdout.                                                                                                                                                                                                                                                                       |
| `errors`             | `CliError`                                                                                                                                                      | Typed CLI error class with `code` and exit-code mapping.                                                                                                                                                                                                                                                                                                                                  |
| `global-args`        | `parseGlobalArgs`, `createGlobalArgsStore`, `createAccessibleGate`, `createSpinnerGate`, `getProgressJsonlPath`, `isProgressJsonlEnabled`                       | Parse well-known global flags (`--json`, `--ndjson`, `--quiet`, `--verbose`, `--accessible`, `--no-spinner`, `--progress-jsonl`) and derive predicates from them.                                                                                                                                                                                                                         |
| `json`               | `formatJson`, `formatNdjson`                                                                                                                                    | Stable JSON / newline-delimited JSON formatting for stdout.                                                                                                                                                                                                                                                                                                                               |
| `markdown` (subpath) | `preloadMarkdown`, `renderMarkdown`, `TerminalRendererOptions`                                                                                                  | Lazy-init terminal markdown renderer. **Requires** `marked` and `marked-terminal-renderer` as peer-deps — install only if your CLI uses this subpath.                                                                                                                                                                                                                                     |
| `options`            | `ViewOptions`                                                                                                                                                   | Type contract for `{ json?, ndjson? }` per-command options that machine-output gates derive from.                                                                                                                                                                                                                                                                                         |
| `spinner`            | `createSpinner`                                                                                                                                                 | Loading spinner factory wrapping `yocto-spinner` with disable gates.                                                                                                                                                                                                                                                                                                                      |
| `terminal`           | `isCI`, `isStderrTTY`, `isStdinTTY`, `isStdoutTTY`                                                                                                              | TTY / CI detection helpers.                                                                                                                                                                                                                                                                                                                                                               |
| `testing` (subpath)  | `describeEmptyMachineOutput`                                                                                                                                    | Vitest helpers reusable by consuming CLIs (e.g. parametrised empty-state suite covering `--json` / `--ndjson` / human modes).                                                                                                                                                                                                                                                             |

## Usage

### Global args + spinner gate

```ts
import { createGlobalArgsStore, createSpinnerGate, createSpinner } from '@doist/cli-core'

const store = createGlobalArgsStore()
export const isJsonMode = () => store.get().json

const shouldDisableSpinner = createSpinnerGate({
    envVar: 'TD_SPINNER',
    getArgs: store.get,
})
const { withSpinner } = createSpinner({ isDisabled: shouldDisableSpinner })
```

### Empty-state print

```ts
import { printEmpty } from '@doist/cli-core'

if (tasks.length === 0) {
    printEmpty({ options, message: 'No tasks found.' })
    return
}
```

### Markdown rendering (optional subpath)

Install the peer-deps in the consuming CLI:

```bash
npm install marked marked-terminal-renderer
```

Then:

```ts
import { preloadMarkdown, renderMarkdown } from '@doist/cli-core/markdown'

if (!options.json && !options.raw) {
    await preloadMarkdown()
}
console.log(await renderMarkdown(comment.body))
```

If the peer-deps are missing, `preloadMarkdown` throws a clear error pointing to the install command. TypeScript will also fail to resolve the subpath's types until the peers are installed.

### Standard commands (optional subpath)

Install the peer-dep in the consuming CLI:

```bash
npm install commander
```

Then wire `<cli> changelog` in one call:

```ts
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { registerChangelogCommand } from '@doist/cli-core/commands'
import packageJson from '../package.json' with { type: 'json' }

registerChangelogCommand(program, {
    path: join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'CHANGELOG.md'),
    repoUrl: 'https://github.com/Doist/todoist-cli',
    version: packageJson.version,
})
```

The helper throws `CliError` (`INVALID_TYPE` for a bad `--count`, `FILE_READ_ERROR` if the file can't be read) so the CLI's top-level error handler formats and exits.

Wire `<cli> update` and `<cli> update switch` similarly:

```ts
import { createSpinner, getConfigPath } from '@doist/cli-core'
import { registerUpdateCommand } from '@doist/cli-core/commands'
import packageJson from '../package.json' with { type: 'json' }

const { withSpinner } = createSpinner()
registerUpdateCommand(program, {
    packageName: '@doist/todoist-cli',
    currentVersion: packageJson.version,
    configPath: getConfigPath('todoist-cli'),
    changelogCommandName: 'td changelog',
    withSpinner,
})
```

`update` checks the configured channel's npm dist-tag (`stable` → `latest`, `pre-release` → `next`), compares against `currentVersion`, and shells out to `npm i -g` (or `pnpm add -g` if `npm_execpath` indicates pnpm). `update switch --stable | --pre-release` flips the persisted `update_channel` field via `updateConfig`, preserving any sibling keys. Both subcommands accept `--json` / `--ndjson`. Errors are `CliError` (`INVALID_FLAGS`, `UPDATE_CHECK_FAILED`, `UPDATE_INSTALL_FAILED`, or the canonical `CONFIG_*` codes if the config file is broken).

The semver helpers (`parseVersion`, `compareVersions`, `isNewer`, `getInstallTag`, `fetchLatestVersion`, `getConfiguredUpdateChannel`) are also exported for ad-hoc use outside the registered command.

### Auth (optional subpath)

Wire `<cli> [auth] login` and the supporting OAuth runtime in one call. cli-core ships the standard public-client PKCE flow (`createPkceProvider`) and a single-user config-backed `TokenStore` (`createConfigTokenStore`). Bespoke flows (Dynamic Client Registration, device code, magic link, username/password) implement the `AuthProvider` interface directly — no cli-core release needed.

`logout`, `status`, and `token` are intentionally **not** in this surface yet. They're short and currently CLI-specific in shape; each CLI keeps its own implementations until a concrete migration proves them worth sharing. OS-keychain-backed storage and multi-account stores are likewise out of scope for this first release — implement the `TokenStore` interface directly until the shared shape stabilises.

Install peer-deps in the consuming CLI:

```bash
npm install commander open   # `open` is optional
```

Then:

```ts
import { createSpinner, getConfigPath } from '@doist/cli-core'
import {
    createConfigTokenStore,
    createPkceProvider,
    registerAuthCommand,
} from '@doist/cli-core/auth'

type Account = { id: string; label?: string; email: string }

const configPath = getConfigPath('outline-cli')
const store = createConfigTokenStore<Account>({ configPath })

const provider = createPkceProvider<Account>({
    authorizeUrl: ({ handshake }) => `${handshake.baseUrl as string}/oauth/authorize`,
    tokenUrl: ({ handshake }) => `${handshake.baseUrl as string}/oauth/token`,
    clientId: ({ flags }) => flags.clientId as string,
    scopes: ['read', 'write'],
    validate: async ({ token, handshake }) => probeUser(token, handshake.baseUrl as string),
})

const { withSpinner } = createSpinner()
registerAuthCommand<Account>(program, {
    displayName: 'Outline',
    provider,
    store,
    resolveScopes: ({ readOnly }) => (readOnly ? ['read'] : ['read', 'write']),
    callbackPort: { preferred: 54969, fallbackCount: 5 },
    renderSuccess: (ctx) => `<html>...</html>`,
    renderError: (ctx) => `<html>...</html>`,
    withSpinner,
})
```

The success / error HTML is a render hook — every CLI brings its own template (no shared layout enforced). Errors are `CliError` (`AUTH_OAUTH_FAILED`, `AUTH_STATE_MISMATCH`, `AUTH_CALLBACK_TIMEOUT`, `AUTH_PORT_BIND_FAILED`, `AUTH_TOKEN_EXCHANGE_FAILED`, `AUTH_STORE_WRITE_FAILED`); the consumer's top-level handler formats and exits.

For a lower-level integration that doesn't want the registrar, `runOAuthFlow` and `startCallbackServer` are exposed directly.

## Development

```bash
npm install
npm run build
npm test
npm run check   # oxlint + oxfmt --check (PR gate)
npm run fix     # oxlint --fix + oxfmt
```

See [AGENTS.md](AGENTS.md) for project conventions, including the rule that this README is kept in sync with public API changes.

## License

MIT
