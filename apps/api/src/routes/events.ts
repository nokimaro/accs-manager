import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import type { AppEnv } from '../deps.ts'
import { findSessionById } from '../lib/sessions.ts'

const HEARTBEAT_MS = 25_000

/**
 * Live events for the SPA. Each connection subscribes to the in-process bus fan-out.
 * The session is re-validated on every heartbeat: once it is revoked or expired, or the admin is
 * disabled, the client gets one `unauthorized` event and the stream ends.
 */
export const eventRoutes = new Hono<AppEnv>().get('/events', (c) => {
  c.header('X-Accel-Buffering', 'no')
  c.header('Cache-Control', 'no-cache')
  const { bus, db, logger, sseHeartbeatMs = HEARTBEAT_MS } = c.get('deps')
  const sessionId = c.get('sessionId')!
  return streamSSE(c, async (stream) => {
    let open = true
    let timer: ReturnType<typeof setTimeout> | undefined
    let wake: (() => void) | undefined
    // unlike stream.sleep(), an abort ends the wait at once instead of holding the timer for a full beat
    const sleep = (ms: number) =>
      new Promise<void>((resolve) => {
        wake = resolve
        timer = setTimeout(resolve, ms)
      })
    stream.onAbort(() => {
      open = false
      wake?.()
    })
    // return the write promise so the bus catches a rejected write (client gone) instead of an unhandled rejection
    const unsubscribe = bus.subscribe((event) => stream.writeSSE({ event: event.type, data: JSON.stringify(event) }))
    try {
      await stream.writeSSE({ event: 'ready', data: '{}' })
      while (open) {
        await sleep(sseHeartbeatMs)
        if (!open) break
        let valid: boolean
        try {
          valid = (await findSessionById(db, sessionId)) !== null
        } catch (err) {
          // fail closed: the browser reconnects and the request is authenticated again
          logger.warn({ err }, 'events: session check failed, closing the stream')
          break
        }
        if (!valid) {
          await stream.writeSSE({ event: 'unauthorized', data: '{}' })
          break
        }
        await stream.writeSSE({ event: 'ping', data: '{}' })
      }
    } finally {
      clearTimeout(timer)
      unsubscribe()
    }
  })
})
