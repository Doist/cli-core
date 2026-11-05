# Check: evidence

Apply to the PR description and any report from an agent.

## Report

- A behaviour claim ("fixed", "works", "safe", "no regressions") with no test or command that ran it.
- A "Not verified" section missing when something could not be checked: the CLIs that depend on this package, the real keyring or OAuth flow, the other Node version CI tests on.
- A change to an export without the one fact that makes it safe for the CLIs, or without saying whether a build was tried in one of them.
- A PR title whose type doesn't match the change: behaviour changes need `feat:`, `fix:` or `perf:` to release (`!` for breaking); tooling and docs use `chore:`, `ci:`, `docs:` or `test:` so they don't.

## Fine

- Claims about what the code shows, with the cited line.
