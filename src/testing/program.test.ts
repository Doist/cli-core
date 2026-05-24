import { Command } from 'commander'
import { describe, expect, it, vi } from 'vitest'

import { createTestProgram } from './program.js'

describe('createTestProgram', () => {
    it('returns a Command after running the register callback', () => {
        const register = vi.fn((program: Command) => {
            program.command('greet').action(() => {})
        })
        const program = createTestProgram(register)

        expect(program).toBeInstanceOf(Command)
        expect(register).toHaveBeenCalledWith(program)
    })

    it('runs a registered command action', async () => {
        const action = vi.fn()
        const program = createTestProgram((p) => {
            p.command('greet').action(action)
        })

        await program.parseAsync(['node', 'cli', 'greet'])

        expect(action).toHaveBeenCalled()
    })

    it('throws instead of calling process.exit on an unknown command (exitOverride)', async () => {
        const program = createTestProgram((p) => {
            p.command('greet').action(() => {})
        })

        await expect(program.parseAsync(['node', 'cli', 'nope'])).rejects.toMatchObject({
            code: 'commander.unknownCommand',
        })
    })
})
