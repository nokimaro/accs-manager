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

export interface CodeCollectorOptions {
  /** waits before trying again when resolving @VerificationCodes or the catch-up fails; then it gives up until the next connect */
  retryDelaysMs?: number[]
}

const DEFAULT_RETRY_DELAYS = [15_000, 60_000, 300_000]
const DAY_MS = 86_400_000

/**
 * Reads codes from the @VerificationCodes chat of every running account: live messages as they come, and
 * on each (re)connect everything newer than the last stored message. Storing is idempotent (unique key).
 */
export function createCodeCollector(deps: WorkerDeps, hooks: CodeHooks = {}, options: CodeCollectorOptions = {}) {
  const { db, logger, bus, settings } = deps
  const retryDelays = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS
  /** the client each account currently runs: retries stop once it is replaced */
  const current = new Map<string, TelegramSession>()

  /** Runs `step`; on failure tries again later, as long as `session` is still the account's client. */
  async function retrying(account: AccountRow, session: TelegramSession, what: string, step: () => Promise<void>, attempt = 0): Promise<void> {
    try {
      await step()
    } catch (err) {
      const delay = retryDelays[attempt]
      if (delay === undefined || current.get(account.id) !== session) {
        logger.error({ err, accountId: account.id }, `codes: ${what} failed, giving up until the next connect`)
        return
      }
      logger.warn({ err, accountId: account.id, attempt: attempt + 1 }, `codes: ${what} failed, retrying`)
      setTimeout(() => void retrying(account, session, what, step, attempt + 1), delay).unref()
    }
  }

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
      current.set(account.id, session)
      const catchUp = async (sourceId: number) => {
        const [last] = await db
          .select({ id: codeMessages.tgMessageId })
          .from(codeMessages)
          .where(eq(codeMessages.accountId, account.id))
          .orderBy(desc(codeMessages.tgMessageId))
          .limit(1)
        // what housekeeping would delete anyway is not brought back (a reconnect after retention would re-add it)
        const cutoff = Date.now() - settings.get('retention.codeMessagesDays') * DAY_MS
        const missed = (await session.history(sourceId, last?.id ?? 0, HISTORY_LIMIT)).filter((m) => m.date.getTime() >= cutoff)
        for (const message of missed) await save(account, message, false)
        logger.info({ accountId: account.id, caughtUp: missed.length }, 'codes: watching @VerificationCodes')
      }
      // without the source there is no listener at all: a transient failure must not leave the account deaf
      await retrying(account, session, 'resolving @VerificationCodes', async () => {
        const sourceId = await session.resolveUserId(CODE_SOURCE_USERNAME)
        session.onMessage((message) => {
          if (message.senderId !== sourceId) return
          save(account, message, true).catch((err: unknown) => logger.error({ err, accountId: account.id }, 'codes: failed to store a message'))
        })
        await retrying(account, session, 'history catch-up', () => catchUp(sourceId))
      })
    },
  }
}
