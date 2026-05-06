import { describe, expect, expectTypeOf, it } from 'vitest'

import {
    BROKEN_CONFIG_STATE_TO_CODE,
    CliError,
    type CliErrorCode,
    type ConfigErrorCode,
    formatJson,
    formatNdjson,
    getConfigPath,
    isCI,
    isStderrTTY,
    isStdinTTY,
    isStdoutTTY,
    readConfig,
    readConfigStrict,
    updateConfig,
    writeConfig,
} from './index.js'

// Smoke-tests pinning the public API from the package root. Type re-exports
// would silently disappear from a runtime-only suite, so each one is anchored
// to a value or assertion here.

describe('package root exports', () => {
    it('re-exports the runtime values', () => {
        expect(typeof CliError).toBe('function')
        expect(typeof formatJson).toBe('function')
        expect(typeof formatNdjson).toBe('function')
        expect(typeof getConfigPath).toBe('function')
        expect(typeof isCI).toBe('function')
        expect(typeof isStderrTTY).toBe('function')
        expect(typeof isStdinTTY).toBe('function')
        expect(typeof isStdoutTTY).toBe('function')
        expect(typeof readConfig).toBe('function')
        expect(typeof readConfigStrict).toBe('function')
        expect(typeof updateConfig).toBe('function')
        expect(typeof writeConfig).toBe('function')
        expect(BROKEN_CONFIG_STATE_TO_CODE).toEqual({
            'read-failed': 'CONFIG_READ_FAILED',
            'invalid-json': 'CONFIG_INVALID_JSON',
            'invalid-shape': 'CONFIG_INVALID_SHAPE',
        })
    })

    it('re-exports the canonical error code types', () => {
        // Each literal must satisfy ConfigErrorCode; if the type re-export
        // ever disappears, the assignment fails to compile.
        const read: ConfigErrorCode = 'CONFIG_READ_FAILED'
        const json: ConfigErrorCode = 'CONFIG_INVALID_JSON'
        const shape: ConfigErrorCode = 'CONFIG_INVALID_SHAPE'
        expect([read, json, shape]).toEqual([
            'CONFIG_READ_FAILED',
            'CONFIG_INVALID_JSON',
            'CONFIG_INVALID_SHAPE',
        ])

        // CliErrorCode currently equals ConfigErrorCode; assert both type-and-
        // runtime relationships.
        const aliased: CliErrorCode = 'CONFIG_READ_FAILED'
        expect(aliased).toBe('CONFIG_READ_FAILED')
        expectTypeOf<ConfigErrorCode>().toMatchTypeOf<CliErrorCode>()
    })
})
