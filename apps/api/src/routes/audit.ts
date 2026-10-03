import { zValidator } from '@hono/zod-validator'
import { admins, auditLog } from '@workspace/db'
import { auditQuery, type AuditPage } from '@workspace/shared/api'
import { and, count, desc, eq, gte, lte, type SQL } from 'drizzle-orm'
import { Hono } from 'hono'
import type { AppEnv } from '../deps.ts'
import { validationHook } from './validation.ts'

export const auditRoutes = new Hono<AppEnv>().get('/audit', zValidator('query', auditQuery, validationHook), async (c) => {
  const { db } = c.get('deps')
  const q = c.req.valid('query')
  const filters: SQL[] = []
  if (q.adminId) filters.push(eq(auditLog.adminId, q.adminId))
  if (q.action) filters.push(eq(auditLog.action, q.action))
  if (q.from) filters.push(gte(auditLog.createdAt, new Date(q.from)))
  if (q.to) filters.push(lte(auditLog.createdAt, new Date(q.to)))
  const where = filters.length > 0 ? and(...filters) : undefined

  const [rows, [total]] = await Promise.all([
    db
      .select({ entry: auditLog, adminLogin: admins.login })
      .from(auditLog)
      .leftJoin(admins, eq(admins.id, auditLog.adminId))
      .where(where)
      .orderBy(desc(auditLog.id))
      .limit(q.pageSize)
      .offset((q.page - 1) * q.pageSize),
    db.select({ n: count() }).from(auditLog).where(where),
  ])

  return c.json({
    items: rows.map(({ entry, adminLogin }) => ({
      id: String(entry.id),
      actorType: entry.actorType,
      adminId: entry.adminId,
      adminLogin,
      action: entry.action,
      targetType: entry.targetType,
      targetId: entry.targetId,
      payload: entry.payload,
      ip: entry.ip,
      userAgent: entry.userAgent,
      statusCode: entry.statusCode,
      result: entry.result,
      durationMs: entry.durationMs,
      createdAt: entry.createdAt.toISOString(),
    })),
    total: total?.n ?? 0,
    page: q.page,
    pageSize: q.pageSize,
  } satisfies AuditPage)
})
