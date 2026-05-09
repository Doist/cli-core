import { createServer, type Server } from 'node:http'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
    type CallbackServerHandle,
    startCallbackServer,
    type StartCallbackServerOptions,
} from './callback-server.js'

const renderSuccess = () => '<html><body>ok</body></html>'
const renderError = (ctx: { message: string }) => `<html><body>${ctx.message}</body></html>`

const baseOptions = (
    overrides: Partial<StartCallbackServerOptions> = {},
): StartCallbackServerOptions => ({
    preferredPort: 0, // 0 = OS-assigned ephemeral; pre-emptively unused
    expectedState: 'expected-state',
    renderSuccess,
    renderError,
    displayName: 'TestCli',
    ...overrides,
})

let handle: CallbackServerHandle | null = null
let blocker: Server | null = null

beforeEach(() => {
    handle = null
    blocker = null
})

afterEach(async () => {
    if (handle) await handle.stop()
    if (blocker) {
        await new Promise<void>((resolve) => {
            blocker?.close(() => resolve())
        })
    }
})

async function bindRandomPort(): Promise<number> {
    blocker = createServer()
    await new Promise<void>((resolve) => {
        blocker?.listen(0, '127.0.0.1', () => resolve())
    })
    const address = blocker.address()
    if (!address || typeof address === 'string') throw new Error('no address')
    return address.port
}

describe('startCallbackServer', () => {
    it('binds the preferred port and resolves with code+state on a valid callback', async () => {
        handle = await startCallbackServer(baseOptions())
        const callbackPromise = handle.waitForCallback(2000)
        const res = await fetch(`${handle.redirectUri}?code=abc&state=expected-state`)
        expect(res.status).toBe(200)
        const result = await callbackPromise
        expect(result).toEqual({ code: 'abc', state: 'expected-state' })
    })

    it.each([
        {
            name: 'state mismatch',
            query: 'code=abc&state=wrong',
            code: 'AUTH_STATE_MISMATCH',
        },
        {
            name: 'provider returned ?error=...',
            query: 'error=access_denied&error_description=denied',
            code: 'AUTH_OAUTH_FAILED',
        },
        {
            name: 'code or state missing',
            query: 'code=abc',
            code: 'AUTH_OAUTH_FAILED',
        },
    ])('rejects with $code on $name', async ({ query, code }) => {
        handle = await startCallbackServer(baseOptions())
        const assertion = expect(handle.waitForCallback(2000)).rejects.toMatchObject({ code })
        const res = await fetch(`${handle.redirectUri}?${query}`)
        expect(res.status).toBe(400)
        await assertion
    })

    it('returns 404 for non-callback paths without settling waitForCallback', async () => {
        handle = await startCallbackServer(baseOptions())
        // Start the wait first so we can prove the 404 doesn't settle it.
        let settled = false
        const waiting = handle.waitForCallback(150).then(
            () => {
                settled = true
                return 'fulfilled' as const
            },
            (err: unknown) => {
                settled = true
                return err
            },
        )
        const wrongPath = handle.redirectUri.replace('/callback', '/other')
        const res = await fetch(wrongPath)
        expect(res.status).toBe(404)
        expect(settled).toBe(false) // 404 must not settle the callback promise
        // Drain the timeout so vitest doesn't see an open promise.
        const outcome = await waiting
        expect(outcome).toMatchObject({ code: 'AUTH_CALLBACK_TIMEOUT' })
    })

    it('walks to the next free port when the preferred one is busy', async () => {
        const taken = await bindRandomPort()
        handle = await startCallbackServer(
            baseOptions({ preferredPort: taken, portFallbackCount: 5 }),
        )
        expect(handle.port).toBeGreaterThan(taken)
        expect(handle.port).toBeLessThanOrEqual(taken + 5)
    })

    it('throws AUTH_PORT_BIND_FAILED when every port in range is busy', async () => {
        // Bind a string of consecutive ports so the fallback walk has nowhere to land.
        const blockers: Server[] = []
        const startPort = await bindRandomPort()
        for (let i = 1; i <= 3; i++) {
            const s = createServer()
            await new Promise<void>((resolve, reject) => {
                s.once('error', reject)
                s.listen(startPort + i, '127.0.0.1', () => resolve())
            })
            blockers.push(s)
        }
        try {
            await expect(
                startCallbackServer(
                    baseOptions({ preferredPort: startPort, portFallbackCount: 3 }),
                ),
            ).rejects.toMatchObject({ code: 'AUTH_PORT_BIND_FAILED' })
        } finally {
            for (const s of blockers) {
                await new Promise<void>((resolve) => s.close(() => resolve()))
            }
        }
    })

    it('times out when no callback arrives', async () => {
        handle = await startCallbackServer(baseOptions())
        await expect(handle.waitForCallback(50)).rejects.toMatchObject({
            code: 'AUTH_CALLBACK_TIMEOUT',
        })
    })

    it('stop() is idempotent', async () => {
        handle = await startCallbackServer(baseOptions())
        await handle.stop()
        await handle.stop()
    })

    it('stop() while waitForCallback is pending settles the wait with AUTH_OAUTH_FAILED', async () => {
        handle = await startCallbackServer(baseOptions())
        const assertion = expect(handle.waitForCallback(60_000)).rejects.toMatchObject({
            code: 'AUTH_OAUTH_FAILED',
        })
        await handle.stop()
        await assertion
    })

    it('rejects invalid preferredPort with AUTH_PORT_BIND_FAILED', async () => {
        await expect(startCallbackServer(baseOptions({ preferredPort: -1 }))).rejects.toMatchObject(
            { code: 'AUTH_PORT_BIND_FAILED' },
        )
        await expect(
            startCallbackServer(baseOptions({ preferredPort: 70000 })),
        ).rejects.toMatchObject({ code: 'AUTH_PORT_BIND_FAILED' })
    })
})
