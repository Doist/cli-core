# Check: security

Every Doist CLI runs this code with the user's tokens. Apply to changes in `src/` and `templates/`.

## Report

- An access token, refresh token, `Authorization` header or `GH_TOKEN` written to output, logs, errors or JSON.
- Token storage that bypasses the keyring-backed store in `src/auth/keyring/`, or a plaintext fallback beyond the documented offline case.
- OAuth changes that weaken PKCE or `state` checks, bind the callback server beyond loopback, or accept a redirect the flow didn't ask for (`src/auth/flow.ts`, `src/auth/pkce.ts`, `src/auth/providers/`).
- Extensions: a command built as a shell string instead of `spawn`/`execFile` with an argument list; a secret reaching third-party code, such as an extension's `npm install`, which runs with `secretEnvVars` stripped (`src/extensions/npm.ts`); an extension name or install source that can escape its directory (`src/extensions/source.ts`); scaffolding that writes outside the target (`src/extensions/create.ts`).
- A URL opened in the browser without checking it is an http(s) URL.
- A secret fetched that the caller does not display.

## Fine

- Logging error codes, durations and counts.
- Test fixtures with fake tokens and cli-core's fictional accounts.
