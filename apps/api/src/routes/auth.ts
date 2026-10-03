import { randomUUID } from 'node:crypto'
import { zValidator } from '@hono/zod-validator'
import { admins } from '@workspace/db'
import { changePasswordInput, loginInput, type MeResponse } from '@workspace/shared/api'
import { parseDuration } from '@workspace/shared/duration'
import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { deleteCookie, setCookie } from 'hono/cookie'
import type { AppEnv } from '../deps.ts'
import { hashPassword, verifyPassword } from '../lib/password.ts'
import { checkLimit, clearFailures, recordFailure } from '../lib/rate-limit.ts'
import { createSession, deleteSession, SESSION_COOKIE } from '../lib/sessions.ts'
import { requireAuth } from '../middleware/auth.ts'
import { validationHook } from './validation.ts'
import { findAdminByLogin, setAdminPassword } from '../services/admins.ts'

// Unknown logins still pay for one argon2 verification, so timing does not reveal which logins exist.
const DUMMY_HASH = await hashPassword(randomUUID())

export const authRoutes = new Hono<AppEnv>()
  .post('/auth/login', zValidator('json', loginInput, validationHook), async (c) => {
    const { db, redis, settings, env } = c.get('deps')
    const { login, password } = c.req.valid('json')
    c.set('audit', { action: 'auth.login', payload: { login } })

    const limit = settings.get('security.loginMaxAttempts')
    const windowMs = parseDuration(settings.get('security.loginWindow'))
    const ipKey = `rl:login:ip:${c.get('clientIp')}`
    const userKey = `rl:login:user:${login}`
    const [byIp, byUser] = await Promise.all([checkLimit(redis, ipKey, limit), checkLimit(redis, userKey, limit)])
    if (byIp.limited || byUser.limited) {
      c.header('Retry-After', String(Math.max(byIp.retryAfterSec, byUser.retryAfterSec)))
      return c.json({ error: 'rate_limited', message: 'Слишком много попыток входа' }, 429)
    }

    const admin = await findAdminByLogin(db, login)
    const ok = await verifyPassword(password, admin?.passwordHash ?? DUMMY_HASH)
    if (!admin || !ok || admin.disabledAt) {
      await Promise.all([recordFailure(redis, ipKey, windowMs), recordFailure(redis, userKey, windowMs)])
      return c.json({ error: 'invalid_credentials', message: 'Неверный логин или пароль' }, 401)
    }

    await clearFailures(redis, userKey)
    const ttlMs = parseDuration(settings.get('security.sessionTtl'))
    const session = await createSession(db, { adminId: admin.id, ttlMs, ip: c.get('clientIp'), userAgent: c.req.header('user-agent') ?? null })
    await db.update(admins).set({ lastLoginAt: new Date() }).where(eq(admins.id, admin.id))
    setCookie(c, SESSION_COOKIE, session.token, {
      httpOnly: true,
      sameSite: 'Strict',
      secure: env.PUBLIC_ORIGIN.startsWith('https://'),
      path: '/',
      expires: session.expiresAt,
    })
    c.set('audit', { action: 'auth.login', payload: { login }, adminId: admin.id })
    return c.json({ id: admin.id, login: admin.login } satisfies MeResponse)
  })
  .post('/auth/logout', async (c) => {
    c.set('audit', { action: 'auth.logout' })
    const sessionId = c.get('sessionId')
    if (sessionId) await deleteSession(c.get('deps').db, sessionId)
    deleteCookie(c, SESSION_COOKIE, { path: '/' })
    return c.body(null, 204)
  })
  .get('/auth/me', requireAuth, (c) => c.json(c.get('admin') satisfies MeResponse | null))
  .post('/auth/password', requireAuth, zValidator('json', changePasswordInput, validationHook), async (c) => {
    c.set('audit', { action: 'auth.password.change' })
    const { db } = c.get('deps')
    const me = c.get('admin')!
    const { currentPassword, newPassword } = c.req.valid('json')
    const row = await findAdminByLogin(db, me.login)
    if (!row || !(await verifyPassword(currentPassword, row.passwordHash))) {
      return c.json({ error: 'validation', fields: { currentPassword: 'Неверный текущий пароль' } }, 400)
    }
    await setAdminPassword(db, me.id, newPassword)
    deleteCookie(c, SESSION_COOKIE, { path: '/' })
    return c.body(null, 204)
  })
