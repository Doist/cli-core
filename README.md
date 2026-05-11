# @doist/cli-core

Shared core utilities for Doist CLI projects ([todoist-cli](https://github.com/Doist/todoist-cli), [twist-cli](https://github.com/Doist/twist-cli), [outline-cli](https://github.com/Doist/outline-cli)).

TypeScript, ESM-only, Node ≥ 20.18.1.

## Install

```bash
npm install @doist/cli-core
```

## What's in it

| Module               | Key exports                                                                                                                                                                           | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `auth` (subpath)     | `attachLoginCommand`, `attachLogoutCommand`, `attachStatusCommand`, `attachTokenViewCommand`, `runOAuthFlow`, `createPkceProvider`, PKCE helpers, `AuthProvider` / `TokenStore` types | OAuth runtime plus the Commander attachers for `<cli> [auth] login` / `logout` / `status` / `token`. Ships the standard public-client PKCE flow (`createPkceProvider`); `AuthProvider` and `TokenStore` are the escape hatches for DCR, OS-keychain, multi-account, etc. — consumers implement `TokenStore` directly (a single-user config-file version is ~30 LoC). `commander` (when using the attachers) and `open` (browser launch) are optional peer-deps. |
| `commands` (subpath) | `registerChangelogCommand`, `registerUpdateCommand` (+ semver helpers)                                                                                                                | Commander wiring for cli-core's standard commands (e.g. `<cli> changelog`, `<cli> update`, `<cli> update switch`). **Requires** `commander` as an optional peer-dep.                                                                                                                                                                                                                                                                                            |
| `config`             | `getConfigPath`, `readConfig`, `readConfigStrict`, `writeConfig`, `updateConfig`, `CoreConfig`, `UpdateChannel`                                                                       | Read / write a per-CLI JSON config file with typed error codes; `CoreConfig` is the shape of fields cli-core itself owns (extend it for per-CLI fields).                                                                                                                                                                                                                                                                                                        |
| `empty`              | `printEmpty`                                                                                                                                                                          | Print an empty-state message gated on `--json` / `--ndjson` so machine consumers never see human strings on stdout.                                                                                                                                                                                                                                                                                                                                             |
| `errors`             | `CliError`                                                                                                                                                                            | Typed CLI error class with `code` and exit-code mapping.                                                                                                                                                                                                                                                                                                                                                                                                        |
| `global-args`        | `parseGlobalArgs`, `createGlobalArgsStore`, `createAccessibleGate`, `createSpinnerGate`, `getProgressJsonlPath`, `isProgressJsonlEnabled`                                             | Parse well-known global flags (`--json`, `--ndjson`, `--quiet`, `--verbose`, `--accessible`, `--no-spinner`, `--progress-jsonl`) and derive predicates from them.                                                                                                                                                                                                                                                                                               |
| `json`               | `formatJson`, `formatNdjson`                                                                                                                                                          | Stable JSON / newline-delimited JSON formatting for stdout.                                                                                                                                                                                                                                                                                                                                                                                                     |
| `markdown` (subpath) | `preloadMarkdown`, `renderMarkdown`, `TerminalRendererOptions`                                                                                                                        | Lazy-init terminal markdown renderer. **Requires** `marked` and `marked-terminal-renderer` as peer-deps — install only if your CLI uses this subpath.                                                                                                                                                                                                                                                                                                           |
| `options`            | `ViewOptions`                                                                                                                                                                         | Type contract for `{ json?, ndjson? }` per-command options that machine-output gates derive from.                                                                                                                                                                                                                                                                                                                                                               |
| `spinner`            | `createSpinner`                                                                                                                                                                       | Loading spinner factory wrapping `yocto-spinner` with disable gates.                                                                                                                                                                                                                                                                                                                                                                                            |
| `terminal`           | `isCI`, `isStderrTTY`, `isStdinTTY`, `isStdoutTTY`                                                                                                                                    | TTY / CI detection helpers.                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `testing` (subpath)  | `describeEmptyMachineOutput`                                                                                                                                                          | Vitest helpers reusable by consuming CLIs (e.g. parametrised empty-state suite covering `--json` / `--ndjson` / human modes).                                                                                                                                                                                                                                                                                                                                   |

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

Wire `<cli> [auth] login` and the supporting OAuth runtime. cli-core ships the standard public-client PKCE flow (`createPkceProvider`) and the `attachLoginCommand` Commander helper that drives `runOAuthFlow` end-to-end. Bespoke flows (Dynamic Client Registration, device code, magic link, username / password) implement the `AuthProvider` interface directly — no cli-core release needed. Token storage is a `TokenStore` the consumer provides; cli-core does not ship a default.

#### Install

```bash
npm install commander open
```

`commander` is required when using `attachLoginCommand`. `open` is optional — when it's missing or `open()` throws, the authorize URL is surfaced via `onAuthorizeUrl` (or printed to stdout in human mode, stderr in `--json` / `--ndjson` mode) so the user can complete the flow manually.

#### Quick start (PKCE)

```ts
import { attachLoginCommand, createPkceProvider } from '@doist/cli-core/auth'
import type { TokenStore } from '@doist/cli-core/auth'

type Account = { id: string; label?: string; email: string }

const store: TokenStore<Account> = createTokenStore() // see "Implementing TokenStore" below

const provider = createPkceProvider<Account>({
    authorizeUrl: ({ handshake }) => `${handshake.baseUrl as string}/oauth/authorize`,
    tokenUrl: ({ handshake }) => `${handshake.baseUrl as string}/oauth/token`,
    clientId: ({ flags }) => flags.clientId as string,
    validate: async ({ token, handshake }) => probeUser(token, handshake.baseUrl as string),
})

const auth = program.command('auth')
attachLoginCommand<Account>(auth, {
    provider,
    store,
    preferredPort: 54969,
    portFallbackCount: 5,
    resolveScopes: ({ readOnly }) => (readOnly ? ['read'] : ['read', 'write']),
    renderSuccess: () => `<html>...</html>`,
    renderError: (message) => `<html>${message}</html>`,
    onSuccess: ({ account, view }) => {
        if (view.json) console.log(JSON.stringify({ account }))
        else console.log(`Signed in as ${account.label ?? account.id}`)
    },
}).description('Authenticate via OAuth')
```

`attachLoginCommand` returns the new `Command` so you can chain `.description(...)` / `.option(...)` / `.addHelpText(...)`. Any consumer-attached options land in the `flags` object passed to `resolveScopes`, `onSuccess`, and the provider hooks.

#### Sibling attachers (`logout` / `status` / `token`)

The same registrar shape covers the other three auth subcommands. Each returns the new `Command` for chaining and shares the same `TokenStore<TAccount>` instance.

```ts
import {
    attachLogoutCommand,
    attachStatusCommand,
    attachTokenViewCommand,
} from '@doist/cli-core/auth'

attachLogoutCommand<Account>(auth, {
    store,
    onCleared: ({ account, view }) => {
        // Optional follow-up — surface keyring-fallback warnings, etc.
        // Route extra prose to stderr in machine-output mode.
        if (!view.json && !view.ndjson && account) {
            console.log(`Cleared credential for ${account.label ?? account.id}.`)
        }
    },
})

attachStatusCommand<Account>(auth, {
    store,
    fetchLive: async ({ token }) => probeUser(token), // throws CliError on 401
    renderText: ({ account }) => [
        `Signed in as ${account.label ?? account.id}`,
        `  Email: ${account.email}`,
    ],
    renderJson: ({ account }) => ({ id: account.id, email: account.email }),
})

attachTokenViewCommand<Account>(auth, {
    store,
    envVarName: 'TODOIST_API_TOKEN', // refuse to print when the env var is populated
})
```

`attachLogoutCommand` snapshots `store.active()` (only when `onCleared` is supplied — skipped otherwise to avoid keyring / file I/O), calls `store.clear()`, then emits `✓ Logged out` (human) or `{ "ok": true }` (`--json`, silent under `--ndjson`) before firing `onCleared({ account, view, flags })`.

`attachStatusCommand` reads `store.active()`, optionally runs `fetchLive` (consumer translates 401 → `CliError('NO_TOKEN', …)`), then dispatches to `renderJson` (`--json` / `--ndjson` via `formatJson` / `formatNdjson`, defaults to the account itself, **only invoked in machine-output mode**) or `renderText` (human mode, string or array of lines). When the store is empty it throws `CliError('NOT_AUTHENTICATED', 'Not signed in.')` unless `onNotAuthenticated` is supplied.

Both attachers strip the standard `--json` / `--ndjson` registrar flags from the parsed options and pass the remainder to their callbacks as `flags` — same escape hatch `attachLoginCommand` uses, so a consumer can chain e.g. `.option('--user <ref>')` and read it in `onCleared` / `renderText` / `fetchLive` / `renderJson` / `onNotAuthenticated`.

`attachTokenViewCommand` writes the bare stored token to stdout (no envelope, pipe-safe) and appends a trailing newline only when stdout is a TTY. When `envVarName` is set and the env var is populated, it throws `CliError('TOKEN_FROM_ENV', …)` to avoid disclosing a token the CLI did not manage. Defaults to subcommand name `token`; pass `name: 'view'` to nest under an existing `token` group.

#### Standard flag set

`attachLoginCommand` registers four flags on the `login` subcommand:

| Flag                     | Effect                                                                                 |
| ------------------------ | -------------------------------------------------------------------------------------- |
| `--read-only`            | Threaded through to `resolveScopes` and the provider hooks via `readOnly`.             |
| `--callback-port <port>` | Override `preferredPort` per invocation. Validated as `[0..65535]`; `0` = OS-assigned. |
| `--json`                 | Machine-output mode. Authorize-URL fallback is routed to stderr.                       |
| `--ndjson`               | Machine-output mode. Same fallback routing.                                            |

Under `--json` / `--ndjson`, the authorize-URL fallback (printed when `open` is missing or `open()` throws) goes to stderr so the JSON / NDJSON envelope on stdout stays clean. Pass `onAuthorizeUrl` to override the destination. The success / error HTML returned by `renderSuccess` / `renderError` is a render hook — every CLI brings its own template (no shared layout enforced).

#### Implementing `TokenStore`

A single-user, config-file backed store using cli-core's own config helpers:

```ts
import { getConfigPath, readConfig, updateConfig, writeConfig } from '@doist/cli-core'
import type { TokenStore } from '@doist/cli-core/auth'

type Account = { id: string; label?: string; email: string }
type StoredAuth = { account: Account; token: string }

const configPath = getConfigPath('todoist-cli')

export const tokenStore: TokenStore<Account> = {
    async active() {
        const config = await readConfig<{ auth?: StoredAuth }>(configPath)
        return config.auth ? { account: config.auth.account, token: config.auth.token } : null
    },
    async set(account, token) {
        await updateConfig<{ auth: StoredAuth }>(configPath, { auth: { account, token } })
    },
    async clear() {
        const { auth: _drop, ...rest } = await readConfig<{ auth?: StoredAuth }>(configPath)
        await writeConfig(configPath, rest)
    },
}
```

For OS-keychain-backed or multi-account storage, implement the same three-method interface against your backend of choice. cli-core does not ship a default because the right answer varies per CLI (single-user vs. multi-account, config file vs. keychain, sync vs. lazy decrypt).

#### Custom `AuthProvider` (non-PKCE flows)

Implement `AuthProvider` directly for Dynamic Client Registration, device code, magic-link, etc. The four hooks fire in this order during `runOAuthFlow`:

| Hook            | When                               | Purpose                                                                                                       |
| --------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `prepare?`      | Before the callback server binds   | Pre-flight (e.g. DCR to mint a `client_id`). The returned `handshake` is threaded into every later hook.      |
| `authorize`     | After the callback server is up    | Build the URL the user opens. Returns the URL plus any handshake state needed at exchange (PKCE verifier, …). |
| `exchangeCode`  | After the browser callback fires   | Trade the `code` for an `accessToken`. Optionally returns a fully-resolved `account` to skip `validateToken`. |
| `validateToken` | When `exchangeCode` had no account | Probe an authenticated endpoint to resolve the account.                                                       |

Skeleton:

```ts
import type { AuthProvider } from '@doist/cli-core/auth'

const provider: AuthProvider<Account> = {
    async prepare({ redirectUri, flags }) {
        const { clientId } = await registerClient(redirectUri)
        return { handshake: { clientId } }
    },
    async authorize({ redirectUri, state, scopes, handshake }) {
        const url = buildAuthorizeUrl(handshake.clientId as string, redirectUri, state, scopes)
        return { authorizeUrl: url, handshake }
    },
    async exchangeCode({ code, redirectUri, handshake }) {
        const { access_token } = await postToken(handshake, code, redirectUri)
        return { accessToken: access_token }
    },
    async validateToken({ token }) {
        return probeUser(token)
    },
}
```

The `handshake` is shared mutable state across hooks. `runOAuthFlow` folds the runtime `flags` and `readOnly` values into the handshake before `exchangeCode` and `validateToken`, so resolvers see the same view they had at `authorize` time without you having to re-thread them.

#### Errors

Every failure in this subpath surfaces as a `CliError`:

| Code                         | Cause                                                                                                                                       |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `AUTH_OAUTH_FAILED`          | Provider returned `?error=...`, the flow was aborted via `signal`, or the callback server stopped before completion.                        |
| `AUTH_CALLBACK_TIMEOUT`      | No valid callback within `timeoutMs` (default 3 minutes).                                                                                   |
| `AUTH_PORT_BIND_FAILED`      | Could not bind any port in `[preferredPort, preferredPort + portFallbackCount]`, or `--callback-port` was out of range.                     |
| `AUTH_TOKEN_EXCHANGE_FAILED` | Token endpoint network error, non-2xx response, non-JSON body, or missing `access_token`.                                                   |
| `AUTH_STORE_WRITE_FAILED`    | `TokenStore.set` threw a non-`CliError`. (`CliError`s thrown from `set` propagate unchanged.)                                               |
| `NOT_AUTHENTICATED`          | `status` / `token` ran with an empty `TokenStore` (and no `onNotAuthenticated` callback for `status`). Default message: `'Not signed in.'`. |
| `TOKEN_FROM_ENV`             | `attachTokenViewCommand` refused to print: `envVarName` was set and the env var is populated.                                               |

The consumer's top-level error handler formats and exits.

#### Lower-level: `runOAuthFlow`

For custom Commander wiring (different command name, programmatic invocation, embedding in a non-Commander host) call `runOAuthFlow` directly with the same option set `attachLoginCommand` builds internally:

```ts
import { runOAuthFlow } from '@doist/cli-core/auth'

const result = await runOAuthFlow({
    provider,
    store,
    scopes: ['read', 'write'],
    readOnly: false,
    flags: {},
    preferredPort: 54969,
    renderSuccess: () => `<html>...</html>`,
    renderError: (message) => `<html>${message}</html>`,
})
console.log(result.account)
```

Pass `signal` (an `AbortSignal`) to wire Ctrl-C cancellation; pass `timeoutMs`, `callbackPath`, or `callbackHost` to override the defaults (3 min / `/callback` / `127.0.0.1`).

#### PKCE primitives

For `AuthProvider` implementations that need RFC 7636 helpers without going through `createPkceProvider`:

- `generateVerifier({ length?, alphabet? })` — RFC 7636 verifier (43–128 chars, default 64). Pass a custom `alphabet` to match a specific server's canonicalisation (Todoist drops `.` and `~`).
- `deriveChallenge(verifier)` — `base64url(sha256(verifier))`, the S256 `code_challenge`.
- `generateState()` — 128-bit hex CSRF token suitable for the OAuth `state` parameter.
- `DEFAULT_VERIFIER_ALPHABET` — the 66-char RFC 7636 unreserved set.

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
