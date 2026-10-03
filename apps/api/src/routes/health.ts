import { sql } from '@workspace/db'
import { readWorkerHeartbeat } from '@workspace/server'
import { Hono } from 'hono'
import type { AppEnv } from '../deps.ts'

export const healthRoutes = new Hono<AppEnv>().get('/healthz', async (c) => {
  const { db, redis, env } = c.get('deps')
  // the deployed commit: CI waits for it after a deploy
  const version = env.APP_VERSION
  try {
    await db.execute(sql`select 1`)
    await redis.ping()
    // reported, not judged: the api stays healthy while the worker restarts; CI waits for both versions
    const heartbeat = await readWorkerHeartbeat(redis)
    return c.json({ ok: true, version, worker: heartbeat ? 'ok' : 'down', workerVersion: heartbeat?.version ?? null })
  } catch {
    return c.json({ ok: false, version }, 503)
  }
})
