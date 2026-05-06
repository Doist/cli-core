import { describe, expect, it } from 'vitest'

import { CliError } from './errors.js'

describe('CliError', () => {
    it('captures code, message, hints, and type', () => {
        const error = new CliError('AUTH_FAILED', 'Token rejected', {
            hints: ['Run td auth login'],
            type: 'error',
        })
        expect(error.code).toBe('AUTH_FAILED')
        expect(error.message).toBe('Token rejected')
        expect(error.hints).toEqual(['Run td auth login'])
        expect(error.type).toBe('error')
    })

    it('defaults type to "error" and hints to undefined', () => {
        const error = new CliError('NOT_FOUND', 'Missing')
        expect(error.type).toBe('error')
        expect(error.hints).toBeUndefined()
    })

    it('supports the "info" type without forcing an undefined hints arg', () => {
        const error = new CliError('TOKEN_FROM_ENV', 'Using env token', { type: 'info' })
        expect(error.type).toBe('info')
        expect(error.hints).toBeUndefined()
    })

    it('accepts hints alone without specifying a type', () => {
        const error = new CliError('NOT_FOUND', 'Missing', { hints: ['Check the id'] })
        expect(error.hints).toEqual(['Check the id'])
        expect(error.type).toBe('error')
    })

    it('sets name to CliError and is an Error instance', () => {
        const error = new CliError('X', 'y')
        expect(error.name).toBe('CliError')
        expect(error).toBeInstanceOf(Error)
        expect(error).toBeInstanceOf(CliError)
    })

    it('accepts a constrained code union via the generic parameter', () => {
        type Code = 'A' | 'B' | (string & {})
        const error = new CliError<Code>('A', 'msg')
        expect(error.code).toBe('A')
    })

    it('accepts cli-core canonical codes alongside the consumer union', () => {
        // Consumer's TCode does NOT include CONFIG_INVALID_JSON, but the
        // CliErrorCode aggregator is unioned into the constructor signature
        // so the call still type-checks.
        type Code = 'AUTH_FAILED' | (string & {})
        const error = new CliError<Code>('CONFIG_INVALID_JSON', 'Bad JSON')
        expect(error.code).toBe('CONFIG_INVALID_JSON')
    })
})
