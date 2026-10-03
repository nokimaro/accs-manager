import { getCookie } from 'hono/cookie'
import { createMiddleware } from 'hono/factory'
import type { AppEnv } from '../deps.ts'
import { findSession, SESSION_COOKIE } from '../lib/sessions.ts'

/** Resolves the session cookie into `admin`/`sessionId` (null when absent or invalid). */
export const sessionLoader = createMiddleware<AppEnv>(async (c, next) => {
  c.set('admin', null)
  c.set('sessionId', null)
  const token = getCookie(c, SESSION_COOKIE)
  if (token) {
    const found = await findSession(c.get('deps').db, token)
    if (found) {
      c.set('admin', found.admin)
      c.set('sessionId', found.sessionId)
    }
  }
  await next()
})

export const requireAuth = createMiddleware<AppEnv>(async (c, next) => {
  if (!c.get('admin')) return c.json({ error: 'unauthorized' }, 401)
  await next()
})
