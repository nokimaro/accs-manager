import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import type { AppEnv } from '../deps.ts'

const HEARTBEAT_MS = 25_000

/** Live events for the SPA. Each connection subscribes to the in-process bus fan-out. */
export const eventRoutes = new Hono<AppEnv>().get('/events', (c) => {
  c.header('X-Accel-Buffering', 'no')
  c.header('Cache-Control', 'no-cache')
  const { bus } = c.get('deps')
  return streamSSE(c, async (stream) => {
    let open = true
    // return the write promise so the bus catches a rejected write (client gone) instead of an unhandled rejection
    const unsubscribe = bus.subscribe((event) => stream.writeSSE({ event: event.type, data: JSON.stringify(event) }))
    stream.onAbort(() => {
      open = false
      unsubscribe()
    })
    await stream.writeSSE({ event: 'ready', data: '{}' })
    while (open) {
      await stream.sleep(HEARTBEAT_MS)
      if (open) await stream.writeSSE({ event: 'ping', data: '{}' })
    }
  })
})
