import { sanitizeForAudit, writeAudit, type AuditActor } from '@workspace/server'
import type { Context } from 'hono'
import { createMiddleware } from 'hono/factory'
import { routePath } from 'hono/route'
import type { AppEnv, AuditOverrides } from '../deps.ts'

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])
const MAX_PAYLOAD_CHARS = 16_384
const MAX_BODY_BYTES = 65_536

/**
 * Per-route audit metadata. Also marks a GET as sensitive (audited).
 * Usage: app.get('/accounts/:id/sessions', audited('account.sessions.read', { target: ['account', 'id'] }), handler)
 * Handlers may refine it later: c.set('audit', { ...c.get('audit'), targetId })
 */
export function audited(action: string, options: { target?: [type: string, param: string]; payload?: null } = {}) {
  return createMiddleware<AppEnv>(async (c, next) => {
    const overrides: AuditOverrides = { ...c.get('audit'), action }
    // payload: null — never read the raw body (it may carry secrets); the handler sets a safe payload
    if (options.payload === null) overrides.payload = null
    if (options.target) {
      overrides.targetType = options.target[0]
      const id = c.req.param(options.target[1])
      if (id !== undefined) overrides.targetId = id
    }
    c.set('audit', overrides)
    await next()
  })
}

async function readBody(c: Context<AppEnv>): Promise<unknown> {
  const declared = Number(c.req.header('content-length') ?? 0)
  // never buffer a large body just for the audit log (uploads, abuse); handlers that need it read it themselves
  if (declared > MAX_BODY_BYTES) return { omitted: true, contentLength: declared }

  const type = c.req.header('content-type') ?? ''
  try {
    if (type.includes('application/json')) return await c.req.json()
    if (type.includes('multipart/form-data') || type.includes('application/x-www-form-urlencoded')) return await c.req.parseBody({ all: true })
  } catch {
    return '[unparseable body]'
  }
  return null
}

function capPayload(payload: unknown): unknown {
  const text = JSON.stringify(payload) ?? 'null'
  return text.length > MAX_PAYLOAD_CHARS ? { truncated: true, preview: text.slice(0, 2_000) } : payload
}

/** Writes one audit_log row for every mutating request and every route marked with audited(). */
export const auditTrail = createMiddleware<AppEnv>(async (c, next) => {
  c.set('audit', {})
  const startedAt = performance.now()
  await next()

  const overrides = c.get('audit')
  if (!MUTATING.has(c.req.method) && overrides.action === undefined) return

  const actor: AuditActor = { type: 'admin', adminId: c.get('admin')?.id ?? overrides.adminId ?? null }
  const payload = overrides.payload !== undefined ? overrides.payload : await readBody(c)
  const { db, logger } = c.get('deps')
  try {
    await writeAudit(db, {
      actor,
      action: overrides.action ?? `${c.req.method} ${routePath(c)}`,
      targetType: overrides.targetType ?? null,
      targetId: overrides.targetId ?? null,
      // sanitize BEFORE capping: a truncated preview is a raw JSON string that redaction can no longer see into
      payload: capPayload(sanitizeForAudit(payload)),
      ip: c.get('clientIp'),
      userAgent: c.req.header('user-agent') ?? null,
      statusCode: c.res.status,
      result: c.res.status < 400 ? 'ok' : 'error',
      durationMs: Math.round(performance.now() - startedAt),
    })
  } catch (err) {
    logger.error({ err }, 'audit: failed to write record')
  }
})
