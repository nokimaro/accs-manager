import { createMiddleware } from 'hono/factory'
import type { AppEnv } from '../deps.ts'

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

/** CSRF guard: state-changing requests must come from PUBLIC_ORIGIN. */
export const originGuard = createMiddleware<AppEnv>(async (c, next) => {
  if (!SAFE_METHODS.has(c.req.method)) {
    const expected = new URL(c.get('deps').env.PUBLIC_ORIGIN).origin
    if (c.req.header('origin') !== expected) return c.json({ error: 'forbidden', message: 'Origin mismatch' }, 403)
  }
  await next()
})
