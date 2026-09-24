/**
 * The one way into `schemas.ts`, which is the only module here that imports
 * zod.
 *
 * zod is an optional peer dependency: discovery runs on every invocation of
 * the host CLI and most of those never parse a manifest, so the validator is
 * loaded only when a file is actually read. A host that never installed zod
 * finds out here, with a message that names the fix, rather than from a bare
 * module-not-found error deep inside an `extension install`.
 */

type Schemas = typeof import('./schemas.js')

let loaded: Promise<Schemas> | undefined

export function loadSchemas(): Promise<Schemas> {
    loaded ??= import('./schemas.js').catch((error: unknown) => {
        // Reset so a later call retries rather than replaying the failure
        // after the user has installed the dependency.
        loaded = undefined
        if (isModuleNotFound(error)) {
            throw new Error(
                "@doist/cli-core/extensions requires 'zod' as a peer dependency. Install it with: npm install zod",
                { cause: error },
            )
        }
        throw error
    })
    return loaded
}

function isModuleNotFound(error: unknown): boolean {
    return (
        error instanceof Error &&
        'code' in error &&
        error.code === 'ERR_MODULE_NOT_FOUND' &&
        error.message.includes("'zod'")
    )
}
