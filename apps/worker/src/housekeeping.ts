import { adminSessions, codeMessages, importBatches, lt } from '@workspace/db'
import type { WorkerDeps } from './deps.ts'

/** Hourly cleanup: old codes (retention.codeMessagesDays), unconfirmed imports past their TTL, expired admin sessions. */
export async function housekeeping(deps: WorkerDeps, now = new Date()): Promise<{ codes: number; imports: number; sessions: number }> {
  const { db, settings } = deps
  const codesBefore = new Date(now.getTime() - settings.get('retention.codeMessagesDays') * 86_400_000)
  const codes = await db.delete(codeMessages).where(lt(codeMessages.date, codesBefore)).returning({ id: codeMessages.id })
  // import items (with their encrypted sessions) go with the batch (on delete cascade)
  const imports = await db.delete(importBatches).where(lt(importBatches.expiresAt, now)).returning({ id: importBatches.id })
  const sessions = await db.delete(adminSessions).where(lt(adminSessions.expiresAt, now)).returning({ id: adminSessions.id })
  return { codes: codes.length, imports: imports.length, sessions: sessions.length }
}
