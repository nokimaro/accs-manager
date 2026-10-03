import { codeMessages, desc, eq } from '@workspace/db'
import { CODE_SOURCE_USERNAME } from '@workspace/shared/accounts'
import type { WorkerDeps } from '../deps.ts'
import type { AccountRow } from '../accounts/manager.ts'
import type { IncomingMessage, TelegramSession } from '../telegram/session.ts'
import { extractCode } from './extract.ts'

export type CodeRow = typeof codeMessages.$inferSelect

export interface CodeHooks {
  /** a code message we had not seen; `live` is false for messages caught up from history */
  onCode?: (code: CodeRow, account: AccountRow, live: boolean) => Promise<void> | void
}

/** Messages fetched per account when catching up after downtime. */
export const HISTORY_LIMIT = 100

/**
 * Reads codes from the @VerificationCodes chat of every running account: live messages as they come, and
 * on each (re)connect everything newer than the last stored message. Storing is idempotent (unique key).
 */
export function createCodeCollector(deps: WorkerDeps, hooks: CodeHooks = {}) {
  const { db, logger, bus } = deps

  async function save(account: AccountRow, message: IncomingMessage, live: boolean): Promise<void> {
    const [row] = await db
      .insert(codeMessages)
      .values({ accountId: account.id, tgMessageId: message.id, date: message.date, text: message.text, code: extractCode(message.text, message.markup) })
      .onConflictDoNothing()
      .returning()
    if (!row) return
    await bus.publish({ type: 'code.new', id: row.id, accountId: account.id, code: row.code, date: row.date.toISOString() })
    await hooks.onCode?.(row, account, live)
  }

  return {
    /** AccountHooks.onSessionStarted */
    async attach(account: AccountRow, session: TelegramSession): Promise<void> {
      let sourceId: number
      try {
        sourceId = await session.resolveUserId(CODE_SOURCE_USERNAME)
      } catch (err) {
        logger.warn({ err, accountId: account.id }, 'codes: cannot resolve @VerificationCodes')
        return
      }
      session.onMessage((message) => {
        if (message.senderId !== sourceId) return
        save(account, message, true).catch((err: unknown) => logger.error({ err, accountId: account.id }, 'codes: failed to store a message'))
      })
      const [last] = await db
        .select({ id: codeMessages.tgMessageId })
        .from(codeMessages)
        .where(eq(codeMessages.accountId, account.id))
        .orderBy(desc(codeMessages.tgMessageId))
        .limit(1)
      try {
        const missed = await session.history(sourceId, last?.id ?? 0, HISTORY_LIMIT)
        for (const message of missed) await save(account, message, false)
        logger.info({ accountId: account.id, caughtUp: missed.length }, 'codes: watching @VerificationCodes')
      } catch (err) {
        logger.warn({ err, accountId: account.id }, 'codes: history catch-up failed')
      }
    },
  }
}
