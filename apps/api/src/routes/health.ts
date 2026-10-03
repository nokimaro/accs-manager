import { sql } from 'drizzle-orm'
import { Hono } from 'hono'
import type { AppEnv } from '../deps.ts'

export const healthRoutes = new Hono<AppEnv>().get('/healthz', async (c) => {
  const { db, redis } = c.get('deps')
  try {
    await db.execute(sql`select 1`)
    await redis.ping()
    return c.json({ ok: true })
  } catch {
    return c.json({ ok: false }, 503)
  }
})
