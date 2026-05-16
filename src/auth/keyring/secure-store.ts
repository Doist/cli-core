import { getErrorMessage } from '../../errors.js'

/**
 * Thrown when the OS credential manager cannot be reached — missing native
 * binary for the current architecture, libsecret/D-Bus unavailable
 * (common in WSL / headless Linux / containers / CI), Keychain locked, or
 * any other error returned by the underlying keyring backend.
 *
 * The original throwable is preserved on `cause` so platform-specific
 * diagnostics (stack, native error code) aren't lost — callers that want
 * to degrade to a plaintext fallback should catch this specific class
 * rather than swallowing every `Error`.
 */
export class SecureStoreUnavailableError extends Error {
    constructor(
        message = 'System credential storage is unavailable',
        options?: { cause?: unknown },
    ) {
        super(message, options)
        this.name = 'SecureStoreUnavailableError'
    }
}

export type SecureStore = {
    getSecret(): Promise<string | null>
    setSecret(secret: string): Promise<void>
    deleteSecret(): Promise<boolean>
}

export type CreateSecureStoreOptions = {
    /** Stable per-application identifier (Keychain "service", Credential Manager "target prefix", libsecret "service"). */
    serviceName: string
    /** Per-credential identifier within the service. For multi-account CLIs, typically `user-${id}`. */
    account: string
}

type AsyncEntry = import('@napi-rs/keyring').AsyncEntry

/**
 * Thin wrapper around `@napi-rs/keyring` that normalizes every failure mode
 * into `SecureStoreUnavailableError`. `serviceName` + `account` together
 * identify one credential slot in the OS keyring.
 *
 * The dynamic import + `AsyncEntry` construction is memoised per-store so
 * repeated reads/writes share one entry and a missing native binary
 * fast-fails on subsequent calls instead of retrying the import every time
 * (the rejected promise replays its rejection on each `await`).
 */
export function createSecureStore(options: CreateSecureStoreOptions): SecureStore {
    const { serviceName, account } = options
    let entryPromise: Promise<AsyncEntry> | undefined

    async function withEntry<T>(fn: (entry: AsyncEntry) => Promise<T>): Promise<T> {
        if (!entryPromise) {
            // Dynamic import: `@napi-rs/keyring` is an optional dependency.
            // On unsupported architectures the native binary is absent and
            // a static import would crash module load before we can surface
            // `SecureStoreUnavailableError`.
            entryPromise = (async () => {
                const { AsyncEntry } = await import('@napi-rs/keyring')
                return new AsyncEntry(serviceName, account)
            })()
        }
        try {
            const entry = await entryPromise
            return await fn(entry)
        } catch (error) {
            throw toUnavailableError(error)
        }
    }

    return {
        async getSecret() {
            return withEntry(async (entry) => (await entry.getPassword()) ?? null)
        },
        async setSecret(secret) {
            return withEntry(async (entry) => {
                await entry.setPassword(secret)
            })
        },
        async deleteSecret() {
            return withEntry((entry) => entry.deleteCredential())
        },
    }
}

function toUnavailableError(error: unknown): SecureStoreUnavailableError {
    if (error instanceof SecureStoreUnavailableError) {
        return error
    }
    return new SecureStoreUnavailableError(getErrorMessage(error), { cause: error })
}
