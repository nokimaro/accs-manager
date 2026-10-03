import { auditLog, type Db } from '@workspace/db'

/** `adminId: null` — anonymous request (e.g. a failed login for an unknown user). */
export type AuditActor = { type: 'admin'; adminId: string | null } | { type: 'system' } | { type: 'cli' }

export interface AuditRecord {
  actor: AuditActor
  action: string
  targetType?: string | null
  targetId?: string | null
  payload?: unknown
  ip?: string | null
  userAgent?: string | null
  statusCode?: number | null
  result: 'ok' | 'error'
  durationMs?: number | null
}

const SECRET_KEY = /pass(word|code)?|secret|token|api_?hash|api_?key|auth_?key|cookie|authorization/i
const MAX_STRING = 2_000
const MAX_DEPTH = 6

/** Deep-copies `value`, replacing secret-looking keys, files and oversized strings. */
export function sanitizeForAudit(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value ?? null
  if (typeof value === 'string') return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…[truncated]` : value
  if (typeof value !== 'object') return value
  if (typeof Blob !== 'undefined' && value instanceof Blob) return '[redacted:file]'
  if (depth >= MAX_DEPTH) return '[truncated:depth]'
  if (Array.isArray(value)) return value.map((v) => sanitizeForAudit(v, depth + 1))
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value)) out[k] = SECRET_KEY.test(k) ? '[redacted]' : sanitizeForAudit(v, depth + 1)
  return out
}

export async function writeAudit(db: Db, record: AuditRecord): Promise<void> {
  await db.insert(auditLog).values({
    actorType: record.actor.type,
    adminId: record.actor.type === 'admin' ? record.actor.adminId : null,
    action: record.action,
    targetType: record.targetType ?? null,
    targetId: record.targetId ?? null,
    payload: record.payload === undefined ? null : sanitizeForAudit(record.payload),
    ip: record.ip ?? null,
    userAgent: record.userAgent ?? null,
    statusCode: record.statusCode ?? null,
    result: record.result,
    durationMs: record.durationMs ?? null,
  })
}
