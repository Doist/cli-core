# @doist/cli-core

Shared core utilities for Doist CLI projects ([todoist-cli](https://github.com/Doist/todoist-cli), [twist-cli](https://github.com/Doist/twist-cli), [outline-cli](https://github.com/Doist/outline-cli)).

TypeScript, ESM-only, Node ≥ 20.18.1.

## Install

```bash
npm install @doist/cli-core
```

## What's in it

| Module               | Key exports                                                                                                                               | Purpose                                                                                                                                                           |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `commands` (subpath) | `registerChangelogCommand` (more to come)                                                                                                 | Commander wiring for cli-core's standard commands (e.g. `<cli> changelog`). **Requires** `commander` as an optional peer-dep.                                     |
| `config`             | `getConfigPath`, `readConfig`, `readConfigStrict`, `writeConfig`, `updateConfig`                                                          | Read / write a per-CLI JSON config file with typed error codes for broken or missing state.                                                                       |
| `empty`              | `printEmpty`                                                                                                                              | Print an empty-state message gated on `--json` / `--ndjson` so machine consumers never see human strings on stdout.                                               |
| `errors`             | `CliError`                                                                                                                                | Typed CLI error class with `code` and exit-code mapping.                                                                                                          |
| `global-args`        | `parseGlobalArgs`, `createGlobalArgsStore`, `createAccessibleGate`, `createSpinnerGate`, `getProgressJsonlPath`, `isProgressJsonlEnabled` | Parse well-known global flags (`--json`, `--ndjson`, `--quiet`, `--verbose`, `--accessible`, `--no-spinner`, `--progress-jsonl`) and derive predicates from them. |
| `json`               | `formatJson`, `formatNdjson`                                                                                                              | Stable JSON / newline-delimited JSON formatting for stdout.                                                                                                       |
| `markdown` (subpath) | `preloadMarkdown`, `renderMarkdown`, `darkTheme`, `lightTheme`                                                                            | Lazy-init terminal markdown renderer. **Requires** `marked` and `marked-terminal-renderer` as peer-deps — install only if your CLI uses this subpath.             |
| `spinner`            | `createSpinner`                                                                                                                           | Loading spinner factory wrapping `yocto-spinner` with disable gates.                                                                                              |
| `terminal`           | `isCI`, `isStderrTTY`, `isStdinTTY`, `isStdoutTTY`                                                                                        | TTY / CI detection helpers.                                                                                                                                       |

The `./testing` subpath ships shared test helpers for consumers.

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
