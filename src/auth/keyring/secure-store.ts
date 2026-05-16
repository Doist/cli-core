export const SECURE_STORE_DESCRIPTION = 'system credential manager'

/**
 * Thrown when the OS credential manager cannot be reached — missing native
 * binary for the current architecture, libsecret/D-Bus unavailable
 * (common in WSL / headless Linux / containers / CI), Keychain locked, or
 * any other error returned by the underlying keyring backend.
 *
 * Callers that want to degrade to a plaintext fallback should catch this
 * specific class rather than swallowing every `Error` — anything else
 * coming out of `SecureStore` is a programmer error.
 */
export class SecureStoreUnavailableError extends Error {
    constructor(message = 'System credential storage is unavailable') {
        super(message)
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

/**
 * Thin wrapper around `@napi-rs/keyring` that normalizes every failure mode
 * into `SecureStoreUnavailableError`. `serviceName` + `account` together
 * identify one credential slot in the OS keyring.
 */
export function createSecureStore(options: CreateSecureStoreOptions): SecureStore {
    const { serviceName, account } = options

    return {
        async getSecret(): Promise<string | null> {
            const entry = await getEntry(serviceName, account)
            try {
                return (await entry.getPassword()) ?? null
            } catch (error) {
                throw toUnavailableError(error)
            }
        },

        async setSecret(secret: string): Promise<void> {
            const entry = await getEntry(serviceName, account)
            try {
                await entry.setPassword(secret)
            } catch (error) {
                throw toUnavailableError(error)
            }
        },

        async deleteSecret(): Promise<boolean> {
            const entry = await getEntry(serviceName, account)
            try {
                return await entry.deleteCredential()
            } catch (error) {
                throw toUnavailableError(error)
            }
        },
    }
}

async function getEntry(
    serviceName: string,
    account: string,
): Promise<import('@napi-rs/keyring').AsyncEntry> {
    try {
        // Dynamic import: `@napi-rs/keyring` is an optional dependency. On
        // unsupported architectures (or when the native binary failed to
        // install) a static import would crash module load before we get a
        // chance to surface `SecureStoreUnavailableError` and let the caller
        // fall back to plaintext config storage.
        const { AsyncEntry } = await import('@napi-rs/keyring')
        return new AsyncEntry(serviceName, account)
    } catch (error) {
        throw toUnavailableError(error)
    }
}

function toUnavailableError(error: unknown): SecureStoreUnavailableError {
    if (error instanceof SecureStoreUnavailableError) {
        return error
    }
    const message =
        error instanceof Error ? error.message : 'System credential storage is unavailable'
    return new SecureStoreUnavailableError(message)
}
