export {
    registerExtensionCommands,
    registerExtensionGroup,
    registerExtensionPassThrough,
} from './commands.js'
export type { ExtensionCommandOptions, ExtensionCommands, ExtensionDispatch } from './commands.js'
// `mapWithConcurrency`, `findManifestProblems` and `satisfiesRange` are public
// for hosts that report on installed extensions from a `doctor` command,
// which needs the manager's `list` plus these three checks.
export { mapWithConcurrency } from './concurrency.js'
export { createExtension, defaultTemplatesDir, listTemplates } from './create.js'
export type { CreateContext, CreateOptions, CreateResult } from './create.js'
export type { ExtensionErrorCode } from './errors.js'
export { createExtensionManager } from './manager.js'
export type { ExtensionManager } from './manager.js'
export { findManifestProblems } from './manifest.js'
export type {
    AuthoredManifest,
    DispatchOptions,
    Extension,
    ExtensionKind,
    ExtensionListing,
    ExtensionManagerOptions,
    ExtensionTheme,
    InstalledManifest,
    InstallOptions,
    InstallResult,
    RemoveOptions,
    RemoveResult,
    UpgradeOptions,
    UpgradeOutcome,
    UpgradeResult,
} from './types.js'
export { satisfiesRange } from './version-range.js'
