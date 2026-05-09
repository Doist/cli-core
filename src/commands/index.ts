export { registerChangelogCommand } from './changelog.js'
export type {
    ChangelogBulletMarker,
    ChangelogCommandOptions,
    ChangelogHeadingLevel,
} from './changelog.js'
export type { CommandErrorCode } from './errors.js'
export {
    compareVersions,
    fetchLatestVersion,
    getConfiguredUpdateChannel,
    getInstallTag,
    isNewer,
    parseVersion,
    registerUpdateCommand,
} from './update.js'
export type { UpdateCommandOptions } from './update.js'
