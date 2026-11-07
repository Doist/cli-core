import { text } from 'node:stream/consumers'

import { CliError } from './errors.js'
import { isStdinTTY } from './terminal.js'

export type StdinErrorCode = 'STDIN_IS_TTY'

/**
 * Read piped stdin to the end and return it as a UTF-8 string, for a
 * command's `--stdin` flag.
 *
 * Throws `STDIN_IS_TTY` when stdin is an interactive terminal: with nothing
 * piped in, the read would wait for an EOF that never comes, which an agent
 * or script sees as a hang.
 *
 * The input comes back exactly as read, untrimmed and possibly empty, so each
 * command decides what empty input means (leave a field alone, or clear it).
 */
export async function readStdin(): Promise<string> {
    if (isStdinTTY()) {
        throw new CliError(
            'STDIN_IS_TTY',
            'Expected input piped to stdin, but stdin is an interactive terminal',
            { hints: ['Pipe the content in, e.g. `cat notes.md | …`'] },
        )
    }
    return text(process.stdin)
}
