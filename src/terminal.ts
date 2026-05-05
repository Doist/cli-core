/**
 * Terminal-environment detection helpers shared across the Doist CLIs.
 *
 * These primitives read globals (`process.stdout.isTTY`, `process.env.CI`)
 * directly so callers can compose them. CLI-specific fan-out — opt-out env
 * vars like `TD_SPINNER`, `--json` flags, etc. — stays in the consuming CLI;
 * cli-core only owns the platform signals.
 */

export function isStdoutTTY(): boolean {
    return Boolean(process.stdout.isTTY)
}

export function isStdinTTY(): boolean {
    return Boolean(process.stdin.isTTY)
}

export function isStderrTTY(): boolean {
    return Boolean(process.stderr.isTTY)
}

/**
 * True when the process appears to be running under continuous integration.
 * Checks `process.env.CI`, which every major CI provider (GitHub Actions,
 * GitLab, CircleCI, Buildkite, Travis, …) sets to a truthy value by
 * convention.
 *
 * `CI='false'` is treated as opt-out (handy when a parent environment has
 * `CI=true` set but a nested invocation needs to behave interactively).
 */
export function isCI(): boolean {
    const value = process.env.CI
    return Boolean(value) && value !== 'false'
}
