# Check: privacy and secrets

This repository is public, and the npm package ships `dist/` (including the `./testing` helpers), `templates/` and `CHANGELOG.md` to every CLI.

## Report

- A secret, API key, token or password, even an expired one.
- Real user data in fixtures, tests or docs: real names, emails, account IDs or URLs copied from an account.
- Personal identifiers in docs and examples: real emails, usernames, home-directory paths, local repository names. Use placeholders (`alice@example.com`, `~/code`).
- Internal details: private hostnames, internal URLs, Doist-internal tools or documents.
- A new path in `package.json#files`, or a file under `templates/`, that should not be published.
- Untracked files the change doesn't need (`.env`, logs, `.tmp/`).

## Fine

- cli-core's fictional accounts (`alanGrant`, `ellieSattler`, `ianMalcolm`) and `example.com`.
- Public URLs: GitHub, the npm registry, published RFCs.
