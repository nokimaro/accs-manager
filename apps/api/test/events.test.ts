import type { EventBus } from '@workspace/server'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createApp } from '../src/app.ts'
import { disableAdmin } from '../src/services/admins.ts'
import { loginAs, send, setupApp, type TestApp } from './helpers.ts'

let ta: TestApp
beforeAll(async () => {
  ta = await setupApp()
})
afterAll(async () => {
  await ta.close()
})

async function readUntil(reader: ReadableStreamDefaultReader<Uint8Array>, needle: string): Promise<string> {
  const decoder = new TextDecoder()
  let text = ''
  while (!text.includes(needle)) {
    const { value, done } = await reader.read()
    if (done) break
    text += decoder.decode(value, { stream: true })
  }
  return text
}

/** An app with a short heartbeat whose bus counts live SSE subscriptions. */
function streamingApp(heartbeatMs: number) {
  const counter = { active: 0 }
  const bus: EventBus = {
    ...ta.bus,
    subscribe(handler) {
      counter.active++
      const off = ta.bus.subscribe(handler)
      return () => {
        counter.active--
        off()
      }
    },
  }
  return { app: createApp({ ...ta.deps, bus, sseHeartbeatMs: heartbeatMs }), counter }
}

describe('SSE /api/events', () => {
  it('streams bus events to an authenticated client', async () => {
    const { cookie } = await loginAs(ta)
    const res = await send(ta.app, '/api/events', { cookie })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/text\/event-stream/)
    expect(res.headers.get('x-accel-buffering')).toBe('no')
    const reader = res.body!.getReader()
    expect(await readUntil(reader, 'event: ready')).toContain('event: ready')
    await ta.bus.publish({ type: 'settings.changed', keys: ['notify.enabled'], by: null })
    const text = await readUntil(reader, 'settings.changed')
    expect(text).toContain('event: settings.changed')
    expect(text).toContain('"keys":["notify.enabled"]')
    await reader.cancel()
  })

  it('rejects anonymous clients', async () => {
    expect((await send(ta.app, '/api/events')).status).toBe(401)
  })

  type Me = Awaited<ReturnType<typeof loginAs>>
  it.each<[string, (me: Me) => Promise<unknown>]>([
    ['the session is revoked (logout elsewhere)', (me) => send(ta.app, '/api/auth/logout', { method: 'POST', cookie: me.cookie })],
    ['the admin is disabled', (me) => disableAdmin(ta.deps.db, me.id)],
  ])('sends `unauthorized` and ends the stream once %s', async (_case, revoke) => {
    await loginAs(ta) // keeps another active admin around, so disabling `me` is allowed
    const me = await loginAs(ta)
    const { app, counter } = streamingApp(100)
    const reader = (await send(app, '/api/events', { cookie: me.cookie })).body!.getReader()
    await readUntil(reader, 'event: ready')
    expect(counter.active).toBe(1)

    await revoke(me)
    expect(await readUntil(reader, 'event: unauthorized')).toContain('event: unauthorized')
    expect((await reader.read()).done).toBe(true)
    await vi.waitFor(() => expect(counter.active).toBe(0))
  })

  it('releases the bus subscription and the heartbeat timer as soon as the client goes away', async () => {
    const { cookie } = await loginAs(ta)
    const { app, counter } = streamingApp(60_000)
    const reader = (await send(app, '/api/events', { cookie })).body!.getReader()
    await readUntil(reader, 'event: ready')
    expect(counter.active).toBe(1)
    await reader.cancel()
    // not after the next 60 s heartbeat
    await vi.waitFor(() => expect(counter.active).toBe(0))
  })
})
