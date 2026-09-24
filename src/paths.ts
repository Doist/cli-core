/**
 * Per-user directories that are not the config directory.
 *
 * `getConfigPath` in `config.ts` covers configuration. Data and state are
 * resolved here in the same shape: the XDG variable first, the platform
 * default second, and the app name appended either way.
 *
 * Everything is computed on each call rather than cached at module load, for
 * the same reason `getConfigPath` is: a cached value freezes the home
 * directory before a test has had a chance to point it somewhere harmless.
 */

import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'

/**
 * Windows has no XDG equivalent. `LOCALAPPDATA` is set on every supported
 * version, but it is an ordinary environment variable and can be missing from
 * a stripped-down service environment, so the documented default stands in.
 */
function windowsBase(): string {
    return process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local')
}

/**
 * The XDG spec requires these variables to hold absolute paths and says a
 * relative one must be ignored. Honoring a relative value would tie the
 * directory to wherever the CLI happened to be started from, so something
 * installed in one place would be invisible from another.
 */
function xdgBase(value: string | undefined): string | undefined {
    return value && isAbsolute(value) ? value : undefined
}

/**
 * Where a CLI keeps what the user installed, such as extensions.
 *
 * macOS gets the XDG layout rather than `~/Library/Application Support`,
 * because `getConfigPath` already puts the config at `~/.config` there and
 * splitting the two would leave a user's files in two unrelated places.
 */
export function getDataDir(appName: string): string {
    const xdg = xdgBase(process.env.XDG_DATA_HOME)
    if (xdg) return join(xdg, appName)
    if (process.platform === 'win32') return join(windowsBase(), appName)
    return join(homedir(), '.local', 'share', appName)
}

/**
 * Bookkeeping the CLI can regenerate: pins, update checks. Separate from the
 * data directory so that deleting it loses nothing a user authored.
 *
 * Windows has no state root distinct from its data root, so it nests. That
 * cannot collide with anything under the data directory that is named for
 * what it holds, such as `extensions`.
 */
export function getStateDir(appName: string): string {
    const xdg = xdgBase(process.env.XDG_STATE_HOME)
    if (xdg) return join(xdg, appName)
    if (process.platform === 'win32') return join(windowsBase(), appName, 'state')
    return join(homedir(), '.local', 'state', appName)
}
