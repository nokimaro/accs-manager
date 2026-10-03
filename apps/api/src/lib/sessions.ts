import { createHash, randomBytes } from 'node:crypto'
import { admins, adminSessions, type Db } from '@workspace/db'
import { and, eq, gt, isNull } from 'drizzle-orm'
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

/** Valid = not expired and the admin is not disabled. */
export async function findSession(db: Db, token: string): Promise<{ sessionId: string; admin: SessionAdmin } | null> {
  const [row] = await db
    .select({ sessionId: adminSessions.id, id: admins.id, login: admins.login })
    .from(adminSessions)
    .innerJoin(admins, eq(admins.id, adminSessions.adminId))
    .where(and(eq(adminSessions.tokenHash, hashToken(token)), gt(adminSessions.expiresAt, new Date()), isNull(admins.disabledAt)))
    .limit(1)
  return row ? { sessionId: row.sessionId, admin: { id: row.id, login: row.login } } : null
}

export async function deleteSession(db: Db, sessionId: string): Promise<void> {
  await db.delete(adminSessions).where(eq(adminSessions.id, sessionId))
}

export async function deleteAdminSessions(db: Db, adminId: string): Promise<void> {
  await db.delete(adminSessions).where(eq(adminSessions.adminId, adminId))
}
