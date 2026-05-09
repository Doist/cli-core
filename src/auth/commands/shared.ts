import { CliError } from '../../errors.js'
import { formatJson, formatNdjson } from '../../json.js'
import type { ViewOptions } from '../../options.js'
import type { AuthAccount, AuthProvider, TokenStore } from '../types.js'

/**
 * Centralised `--json` / `--ndjson` / human emitter. Every subcommand
 * delegates here so the three output modes stay aligned across handlers.
 * `humanLines` is a thunk so the human-mode strings (chalk colouring,
 * conditional formatting) are not built when machine output is requested.
 */
export function emitView(
    view: ViewOptions,
    payload: Record<string, unknown>,
    humanLines: () => ReadonlyArray<string>,
): void {
    if (view.json) {
        console.log(formatJson(payload))
        return
    }
    if (view.ndjson) {
        console.log(formatNdjson([payload]))
        return
    }
    for (const line of humanLines()) console.log(line)
}

/**
 * Read a token from piped stdin. Errors with `AUTH_INVALID_TOKEN` when stdin
 * is a TTY (interactive shell) — Doist's secrets-management standard
 * prohibits passing tokens via argv, and there's no in-band way to safely
 * accept one from a TTY without a prompt dependency.
 */
export async function readTokenFromStdin(): Promise<string> {
    if (process.stdin.isTTY) {
        throw new CliError('AUTH_INVALID_TOKEN', 'Token must be piped via stdin.', {
            hints: [
                'Pipe the token: `echo $YOUR_TOKEN | <cli> token set`',
                'Or set the env var (e.g. `<APP>_API_TOKEN=...`).',
            ],
        })
    }
    let buffer = ''
    process.stdin.setEncoding('utf-8')
    for await (const chunk of process.stdin) buffer += chunk
    return buffer.trim()
}

/**
 * Validate a pasted token against the provider, then upsert + activate the
 * resolved account in a single store mutation. Used by `token set` (the only
 * pasted-token entry point now that `login --token` has been removed for
 * argv-secrets safety).
 */
export async function persistPastedToken<TAccount extends AuthAccount>(args: {
    provider: AuthProvider<TAccount>
    store: TokenStore<TAccount>
    rawToken: string
    flags?: Record<string, unknown>
}): Promise<TAccount> {
    if (!args.provider.acceptPastedToken) {
        throw new CliError(
            'AUTH_PROVIDER_UNSUPPORTED',
            'Token paste is not supported by the configured auth provider.',
        )
    }
    const trimmed = args.rawToken.trim()
    if (trimmed.length === 0) {
        throw new CliError('AUTH_INVALID_TOKEN', 'Token cannot be empty.')
    }
    const account = await args.provider.acceptPastedToken({
        token: trimmed,
        flags: args.flags ?? {},
    })
    await args.store.set(account, trimmed, { setActive: true })
    return account
}
