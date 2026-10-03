import { existsSync } from 'node:fs'
import { serveStatic } from '@hono/node-server/serve-static'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import type { AppDeps, AppEnv } from './deps.ts'
import { resolveClientIp } from './lib/client-ip.ts'
import { requireAuth, sessionLoader } from './middleware/auth.ts'
import { originGuard } from './middleware/origin.ts'
import { authRoutes } from './routes/auth.ts'
import { healthRoutes } from './routes/health.ts'

export function createApp(deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  app.use('*', async (c, next) => {
    c.set('deps', deps)
    c.set('clientIp', resolveClientIp(c, deps.env.TRUST_PROXY))
    await next()
  })

  const api = new Hono<AppEnv>()
  api.use('*', originGuard, sessionLoader)
  api.route('/', healthRoutes)
  api.route('/', authRoutes)
  api.use('*', requireAuth)
  api.all('*', (c) => c.json({ error: 'not_found' }, 404))
  app.route('/api', api)

  if (deps.webDistDir && existsSync(deps.webDistDir)) {
    app.use('/*', serveStatic({ root: deps.webDistDir }))
    app.get('*', serveStatic({ root: deps.webDistDir, path: 'index.html' })) // SPA fallback
  }

  app.onError((err, c) => {
    if (err instanceof HTTPException) return err.getResponse()
    deps.logger.error({ err, path: c.req.path }, 'unhandled error')
    return c.json({ error: 'internal', message: 'Внутренняя ошибка' }, 500)
  })

  return app
}
