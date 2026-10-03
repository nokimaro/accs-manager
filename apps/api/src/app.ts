import { existsSync } from 'node:fs'
import { serveStatic } from '@hono/node-server/serve-static'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import type { AppDeps, AppEnv } from './deps.ts'
import { resolveClientIp } from './lib/client-ip.ts'
import { auditTrail } from './middleware/audit.ts'
import { requireAuth, sessionLoader } from './middleware/auth.ts'
import { originGuard } from './middleware/origin.ts'
import { adminRoutes } from './routes/admins.ts'
import { auditRoutes } from './routes/audit.ts'
import { authRoutes } from './routes/auth.ts'
import { healthRoutes } from './routes/health.ts'
import { AdminError } from './services/admins.ts'

const ADMIN_ERRORS = {
  login_taken: [409, 'Логин уже занят'],
  not_found: [404, 'Админ не найден'],
  last_admin: [409, 'Нельзя отключить последнего активного админа'],
} as const

export function createApp(deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  app.use('*', async (c, next) => {
    c.set('deps', deps)
    c.set('clientIp', resolveClientIp(c, deps.env.TRUST_PROXY))
    await next()
  })

  const api = new Hono<AppEnv>()
  api.use('*', originGuard, sessionLoader, auditTrail)
  api.route('/', healthRoutes)
  api.route('/', authRoutes)
  api.use('*', requireAuth)
  api.route('/', adminRoutes)
  api.route('/', auditRoutes)
  api.all('*', (c) => c.json({ error: 'not_found' }, 404))
  app.route('/api', api)

  if (deps.webDistDir && existsSync(deps.webDistDir)) {
    app.use('/*', serveStatic({ root: deps.webDistDir }))
    app.get('*', serveStatic({ root: deps.webDistDir, path: 'index.html' })) // SPA fallback
  }

  app.onError((err, c) => {
    if (err instanceof AdminError) {
      const [status, message] = ADMIN_ERRORS[err.code]
      return c.json({ error: err.code, message }, status)
    }
    if (err instanceof HTTPException) return err.getResponse()
    deps.logger.error({ err, path: c.req.path }, 'unhandled error')
    return c.json({ error: 'internal', message: 'Внутренняя ошибка' }, 500)
  })

  return app
}
