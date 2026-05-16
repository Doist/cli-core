## [0.14.0](https://github.com/Doist/cli-core/compare/v0.13.0...v0.14.0) (2026-05-16)

### Features

* **auth:** tolerate AUTH_STORE_READ_FAILED in logout --user ([#26](https://github.com/Doist/cli-core/issues/26)) ([23652bc](https://github.com/Doist/cli-core/commit/23652bcb436fda917bc10aba99918ce1503786b6))

## [0.13.0](https://github.com/Doist/cli-core/compare/v0.12.0...v0.13.0) (2026-05-16)

### Features

* **auth:** add createSecureStore keyring primitive (1/4) ([#25](https://github.com/Doist/cli-core/issues/25)) ([30bcbd7](https://github.com/Doist/cli-core/commit/30bcbd7e49aede98d0777424169324af03f56eaf))

## [0.12.0](https://github.com/Doist/cli-core/compare/v0.11.0...v0.12.0) (2026-05-14)

### Features

* **auth:** multi-user TokenStore contract ([#23](https://github.com/Doist/cli-core/issues/23)) ([f83310a](https://github.com/Doist/cli-core/commit/f83310a3dec62636884dab6bea2aed3c89aab502))

## [0.11.0](https://github.com/Doist/cli-core/compare/v0.10.0...v0.11.0) (2026-05-12)

### Features

* **auth:** add revokeToken hook to attachLogoutCommand ([#21](https://github.com/Doist/cli-core/issues/21)) ([c7febdd](https://github.com/Doist/cli-core/commit/c7febdd85bbd766496df36d7c9b94eba0265d40e))

### Bug Fixes

* **deps:** update dependency yocto-spinner to v1.2.0 ([#20](https://github.com/Doist/cli-core/issues/20)) ([a15c2ed](https://github.com/Doist/cli-core/commit/a15c2edc8dc84e929ddb8fd19d836083528b10d7))

## [0.10.0](https://github.com/Doist/cli-core/compare/v0.9.0...v0.10.0) (2026-05-12)

### Features

* **auth:** add logout/status/token-view Commander attachers ([#16](https://github.com/Doist/cli-core/issues/16)) ([b7e5385](https://github.com/Doist/cli-core/commit/b7e538543e11c667da6c13938a83eca00836fd88))

## [0.9.0](https://github.com/Doist/cli-core/compare/v0.8.0...v0.9.0) (2026-05-09)

### Features

* **auth:** add attachLoginCommand Commander helper ([#13](https://github.com/Doist/cli-core/issues/13)) ([bb921b8](https://github.com/Doist/cli-core/commit/bb921b83cee128c627bf7c318a016ef4a3b85582))

## [0.8.0](https://github.com/Doist/cli-core/compare/v0.7.1...v0.8.0) (2026-05-09)

### Features

* **auth:** extract OAuth login runtime into ./auth subpath ([#12](https://github.com/Doist/cli-core/issues/12)) ([d402f02](https://github.com/Doist/cli-core/commit/d402f02d45237245259df753dbc8a97e0c7791e8))

## [0.7.1](https://github.com/Doist/cli-core/compare/v0.7.0...v0.7.1) (2026-05-09)

### Bug Fixes

* **update:** drop install-v1 Accept header on dist-tag fetch ([#10](https://github.com/Doist/cli-core/issues/10)) ([4a7b36f](https://github.com/Doist/cli-core/commit/4a7b36f0996479af5c080638dba65a6cd6dd7e56))

## [0.7.0](https://github.com/Doist/cli-core/compare/v0.6.0...v0.7.0) (2026-05-09)

### Features

* add registerUpdateCommand to ./commands subpath ([#9](https://github.com/Doist/cli-core/issues/9)) ([17c6dc7](https://github.com/Doist/cli-core/commit/17c6dc74cd180ddcdb3e30bf2395ad3db05fe5c9))

## [0.6.0](https://github.com/Doist/cli-core/compare/v0.5.0...v0.6.0) (2026-05-09)

### Features

* add ./markdown and ./commands subpaths (optional peer-dep extractions) ([#8](https://github.com/Doist/cli-core/issues/8)) ([6b2ad9d](https://github.com/Doist/cli-core/commit/6b2ad9d5a23b5d1d9ae83a2272e959e927a82d40))

## [0.5.0](https://github.com/Doist/cli-core/compare/v0.4.0...v0.5.0) (2026-05-08)

### Features

* add global args parser + factories ([#7](https://github.com/Doist/cli-core/issues/7)) ([419243e](https://github.com/Doist/cli-core/commit/419243e8543f180e15a2f6efe91d99a4c93bee40))

## [0.4.0](https://github.com/Doist/cli-core/compare/v0.3.0...v0.4.0) (2026-05-08)

### Features

* add printEmpty + describeEmptyMachineOutput helpers ([#6](https://github.com/Doist/cli-core/issues/6)) ([2c0a74e](https://github.com/Doist/cli-core/commit/2c0a74e7874ef47184a071f9fc15f22f254ca20a))

## [0.3.0](https://github.com/Doist/cli-core/compare/v0.2.0...v0.3.0) (2026-05-06)

### Features

* add createSpinner factory ([#5](https://github.com/Doist/cli-core/issues/5)) ([7092427](https://github.com/Doist/cli-core/commit/70924271385bb9ad2009a0d56df5a8768c9943f7))

## [0.2.0](https://github.com/Doist/cli-core/compare/v0.1.0...v0.2.0) (2026-05-06)

### Features

* bake cli-core codes into CliError, add CliErrorCode aggregator ([#4](https://github.com/Doist/cli-core/issues/4)) ([8c0d959](https://github.com/Doist/cli-core/commit/8c0d95987db3b35b1715cd72eb603cbb99420211))

## [0.1.0](https://github.com/Doist/cli-core/compare/v0.0.1...v0.1.0) (2026-05-06)

### Features

- add CliError + config file I/O helpers ([#1](https://github.com/Doist/cli-core/issues/1)) ([8daf2d1](https://github.com/Doist/cli-core/commit/8daf2d1f67f44f91713ffc2192b681704fa86d88))
- add terminal detection + JSON/NDJSON formatters ([#2](https://github.com/Doist/cli-core/issues/2)) ([f2bfde8](https://github.com/Doist/cli-core/commit/f2bfde8ff3a2a41eb402acc49223980c5d4be393))
