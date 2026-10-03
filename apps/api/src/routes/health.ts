import { sql } from 'drizzle-orm'
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
    // reported, not judged: the api stays healthy while the worker restarts
    const worker = (await readWorkerHeartbeat(redis)) ? 'ok' : 'down'
    return c.json({ ok: true, version, worker })
  } catch {
    return c.json({ ok: false, version }, 503)
  }
})
