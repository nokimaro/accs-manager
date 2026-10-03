import { createHash, randomBytes } from 'node:crypto'
import { admins, adminSessions, type Db } from '@workspace/db'
import { and, eq, gt, isNull, type SQL } from '@workspace/db'
import type { SessionAdmin } from '../deps.ts'

export const SESSION_COOKIE = 'accs_session'

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex')

export async function createSession(
  db: Db,
  input: { adminId: string; ttlMs: number; ip: string; userAgent: string | null },
): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString('base64url')
  const expiresAt = new Date(Date.now() + input.ttlMs)
  await db.insert(adminSessions).values({
    tokenHash: hashToken(token),
    adminId: input.adminId,
    expiresAt,
    ip: input.ip,
    userAgent: input.userAgent,
  })
  return { token, expiresAt }
}

type FoundSession = { sessionId: string; admin: SessionAdmin }

/** Valid = not expired and the admin is not disabled. */
async function findValidSession(db: Db, match: SQL): Promise<FoundSession | null> {
  const [row] = await db
    .select({ sessionId: adminSessions.id, id: admins.id, login: admins.login })
    .from(adminSessions)
    .innerJoin(admins, eq(admins.id, adminSessions.adminId))
    .where(and(match, gt(adminSessions.expiresAt, new Date()), isNull(admins.disabledAt)))
    .limit(1)
  return row ? { sessionId: row.sessionId, admin: { id: row.id, login: row.login } } : null
}

export function findSession(db: Db, token: string): Promise<FoundSession | null> {
  return findValidSession(db, eq(adminSessions.tokenHash, hashToken(token)))
}

/** Re-validates an already resolved session (long-lived requests such as the SSE stream). */
export function findSessionById(db: Db, sessionId: string): Promise<FoundSession | null> {
  return findValidSession(db, eq(adminSessions.id, sessionId))
}

export async function deleteSession(db: Db, sessionId: string): Promise<void> {
  await db.delete(adminSessions).where(eq(adminSessions.id, sessionId))
}

export async function deleteAdminSessions(db: Db, adminId: string): Promise<void> {
  await db.delete(adminSessions).where(eq(adminSessions.adminId, adminId))
}
