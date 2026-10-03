import { admins, type Db } from '@workspace/db'
import type { AdminDto } from '@workspace/shared/api'
import { and, asc, count, eq, isNull, ne, sql } from '@workspace/db'
import { hashPassword } from '../lib/password.ts'
import { deleteAdminSessions } from '../lib/sessions.ts'

export class AdminError extends Error {
  readonly code: 'login_taken' | 'not_found' | 'last_admin'
  constructor(code: AdminError['code']) {
    super(code)
    this.code = code
  }
}

type AdminRow = typeof admins.$inferSelect

export function toAdminDto(row: AdminRow): AdminDto {
  return {
    id: row.id,
    login: row.login,
    disabledAt: row.disabledAt?.toISOString() ?? null,
    lastLoginAt: row.lastLoginAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  }
}

export async function listAdmins(db: Db): Promise<AdminDto[]> {
  return (await db.select().from(admins).orderBy(asc(admins.createdAt))).map(toAdminDto)
}

export async function findAdminByLogin(db: Db, login: string): Promise<AdminRow | undefined> {
  const [row] = await db.select().from(admins).where(eq(admins.login, login)).limit(1)
  return row
}

export async function createAdmin(db: Db, input: { login: string; password: string }): Promise<AdminDto> {
  const passwordHash = await hashPassword(input.password)
  const [row] = await db.insert(admins).values({ login: input.login, passwordHash }).onConflictDoNothing().returning()
  if (!row) throw new AdminError('login_taken')
  return toAdminDto(row)
}

/** Revokes all sessions of the admin, atomically with the password change. */
export async function setAdminPassword(db: Db, adminId: string, password: string): Promise<void> {
  const passwordHash = await hashPassword(password)
  await db.transaction(async (tx) => {
    const [row] = await tx.update(admins).set({ passwordHash }).where(eq(admins.id, adminId)).returning({ id: admins.id })
    if (!row) throw new AdminError('not_found')
    await deleteAdminSessions(tx as unknown as Db, adminId)
  })
}

/** Refuses to disable the last active admin; revokes all sessions of the disabled one. */
export async function disableAdmin(db: Db, adminId: string): Promise<AdminDto> {
  return db.transaction(async (tx) => {
    // serialize disables: two concurrent disables must not both pass the last-admin check (write skew)
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('accs:admins:disable'))`)
    const [target] = await tx.select().from(admins).where(eq(admins.id, adminId)).for('update')
    if (!target) throw new AdminError('not_found')
    if (target.disabledAt) return toAdminDto(target)
    const [others] = await tx
      .select({ n: count() })
      .from(admins)
      .where(and(isNull(admins.disabledAt), ne(admins.id, adminId)))
    if ((others?.n ?? 0) === 0) throw new AdminError('last_admin')
    const [row] = await tx.update(admins).set({ disabledAt: new Date() }).where(eq(admins.id, adminId)).returning()
    await deleteAdminSessions(tx as unknown as Db, adminId)
    return toAdminDto(row!)
  })
}
