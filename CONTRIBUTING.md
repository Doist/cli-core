# Contributing

## Setup

```bash
npm install
```

This installs dependencies and registers lefthook git hooks (pre-commit type-check + lint + format, pre-push tests).

## Scripts

- `npm run build` — compile TypeScript to `dist/`
- `npm run dev` — watch-mode build
- `npm test` — run vitest
- `npm run type-check` — typecheck without emit
- `npm run check` — oxlint + oxfmt --check
- `npm run fix` — oxlint --fix + oxfmt

## Commit messages

Conventional Commits are required — semantic-release uses them to determine version bumps. Examples:

- `feat: add token store interface`
- `fix(auth): handle missing keyring`
- `chore: bump deps`

PR titles are validated against the same convention.

## Releases

Pushes to `main` trigger semantic-release via GitHub Actions, which publishes to npm with provenance and updates `CHANGELOG.md`.
