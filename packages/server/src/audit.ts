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

/**
 * Postgres rejects U+0000 (text and jsonb) and lone surrogates (jsonb). Both can come straight from a
 * request body, so every string bound for audit_log goes through this: the insert must never fail on them.
 */
function auditSafeText(text: string): string {
  return text.replaceAll('\u0000', '').toWellFormed()
}

/** Deep-copies `value`, replacing secret-looking keys, files and oversized strings. */
export function sanitizeForAudit(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value ?? null
  if (typeof value === 'string') {
    const text = value.replaceAll('\u0000', '')
    // well-formed after the cut: truncation may split a surrogate pair
    return (text.length > MAX_STRING ? `${text.slice(0, MAX_STRING)}…[truncated]` : text).toWellFormed()
  }
  if (typeof value !== 'object') return value
  if (typeof Blob !== 'undefined' && value instanceof Blob) return '[redacted:file]'
  if (depth >= MAX_DEPTH) return '[truncated:depth]'
  if (Array.isArray(value)) return value.map((v) => sanitizeForAudit(v, depth + 1))
  const out: Record<string, unknown> = {}
  for (const [rawKey, v] of Object.entries(value)) {
    // test the cleaned key: a NUL inside "pass\u0000word" must not dodge redaction
    const k = auditSafeText(rawKey)
    out[k] = SECRET_KEY.test(k) ? '[redacted]' : sanitizeForAudit(v, depth + 1)
  }
  return out
}

const safeText = (text: string | null | undefined) => (text == null ? null : auditSafeText(text))

export async function writeAudit(db: Db, record: AuditRecord): Promise<void> {
  await db.insert(auditLog).values({
    actorType: record.actor.type,
    adminId: record.actor.type === 'admin' ? record.actor.adminId : null,
    action: auditSafeText(record.action),
    targetType: safeText(record.targetType),
    targetId: safeText(record.targetId),
    payload: record.payload === undefined ? null : sanitizeForAudit(record.payload),
    ip: safeText(record.ip),
    userAgent: safeText(record.userAgent),
    statusCode: record.statusCode ?? null,
    result: record.result,
    durationMs: record.durationMs ?? null,
  })
}
