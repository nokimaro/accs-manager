import { existsSync } from 'node:fs'
import { serveStatic } from '@hono/node-server/serve-static'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { HTTPException } from 'hono/http-exception'
import { secureHeaders } from 'hono/secure-headers'
import type { AppDeps, AppEnv } from './deps.ts'
import { resolveClientIp } from './lib/client-ip.ts'
import { auditTrail } from './middleware/audit.ts'
import { requireAuth, sessionLoader } from './middleware/auth.ts'
import { DomainError } from './lib/errors.ts'
import { originGuard } from './middleware/origin.ts'
import { adminRoutes } from './routes/admins.ts'
import { auditRoutes } from './routes/audit.ts'
import { authRoutes } from './routes/auth.ts'
import { codeRoutes } from './routes/codes.ts'
import { eventRoutes } from './routes/events.ts'
import { healthRoutes } from './routes/health.ts'
import { importRoutes } from './routes/imports.ts'
import { proxyRoutes } from './routes/proxies.ts'
import { settingsRoutes } from './routes/settings.ts'
import { WorkerTimeoutError } from '@workspace/server'
import { AdminError } from './services/admins.ts'

/** Global cap on request bodies; the tdata upload is excluded and limited by import.maxZipSizeMb instead. */
const MAX_BODY_BYTES = 1024 * 1024

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
  // HSTS belongs to the reverse proxy: from here its includeSubDomains would also pin the owner's other subdomains.
  // No CSP yet.
  app.use('*', secureHeaders({ strictTransportSecurity: false }))
  // API responses carry per-admin data: never cached by the browser or a proxy
  app.use('/api/*', async (c, next) => {
    await next()
    c.res.headers.set('Cache-Control', 'no-store')
  })

  const api = new Hono<AppEnv>()
  // first: nothing below (origin check, session lookup, audit, validators) may buffer an oversized body;
  // enforced for chunked bodies too, and a 413 short-circuits before the audit trail
  const globalBodyLimit = bodyLimit({ maxSize: MAX_BODY_BYTES, onError: (c) => c.json({ error: 'payload_too_large', message: 'Слишком большой запрос' }, 413) })
  api.use(
    '*',
    // the tdata upload has its own, larger limit (routes/imports.ts)
    (c, next) => (c.req.method === 'POST' && c.req.path === '/api/imports' ? next() : globalBodyLimit(c, next)),
    originGuard,
    sessionLoader,
    auditTrail,
  )
  api.route('/', healthRoutes)
  api.route('/', authRoutes)
  api.use('*', requireAuth)
  api.route('/', adminRoutes)
  api.route('/', settingsRoutes)
  api.route('/', proxyRoutes)
  api.route('/', importRoutes)
  api.route('/', codeRoutes)
  api.route('/', auditRoutes)
  api.route('/', eventRoutes)
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
    if (err instanceof DomainError) return c.json({ error: err.code, message: err.message }, err.status)
    if (err instanceof WorkerTimeoutError) return c.json({ error: 'worker_timeout', message: 'Воркер не ответил вовремя — попробуйте ещё раз' }, 504)
    if (err instanceof HTTPException) return err.getResponse()
    deps.logger.error({ err, path: c.req.path }, 'unhandled error')
    return c.json({ error: 'internal', message: 'Внутренняя ошибка' }, 500)
  })

  return app
}
