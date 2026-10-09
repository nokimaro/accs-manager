import { accounts, and, codeMessages, eq, gt, inArray, isNotNull, isNull, lte, ne, proxies } from '@workspace/db'
import { QUEUE_PREFIX } from '@workspace/server'
import type { AccountStatus } from '@workspace/shared/accounts'
import type { NotifyEvent } from '@workspace/shared/settings'
import { parseDuration } from '@workspace/shared/duration'
import { Queue, Worker, type Job } from 'bullmq'
import type { AccountRow } from '../accounts/manager.ts'
import type { CodeRow } from '../codes/collector.ts'
import type { WorkerDeps } from '../deps.ts'
import { sendBotMessage, type BotFetch } from './bot-api.ts'
import { formatCodeMessage, formatProxyExpiringMessage, formatStatusMessage } from './format.ts'

export const NOTIFY_QUEUE = 'notify'

/** Only ids travel through Redis: the text is built from the database when the job runs. */
export type NotifyJob =
  | { kind: 'code'; codeId: number }
  | { kind: 'status'; accountId: string; status: AccountStatus; reason: string | null }
  | { kind: 'proxyExpiring'; proxyIds: string[] }

const STATUS_EVENTS: Partial<Record<AccountStatus, NotifyEvent>> = {
  proxy_down: 'proxy_down',
  unauthorized: 'unauthorized',
  banned: 'banned',
  frozen: 'frozen',
}

export function createNotifier(deps: WorkerDeps, fetchFn: BotFetch) {
  const { db, settings, logger } = deps
  const prefix = deps.queuePrefix ?? QUEUE_PREFIX
  const queue = new Queue<NotifyJob>(NOTIFY_QUEUE, { connection: deps.queueRedis, prefix })
  let worker: Worker<NotifyJob> | undefined

  /** On and configured, and this kind of event is wanted. */
  function wants(event: NotifyEvent): boolean {
    return settings.get('notify.enabled') && Boolean(settings.get('notify.botToken')) && Boolean(settings.get('notify.chatId')) && settings.get('notify.events').includes(event)
  }

  const enqueue = (job: NotifyJob) =>
    queue.add(job.kind, job, { attempts: 6, backoff: { type: 'exponential', delay: 5_000 }, removeOnComplete: true, removeOnFail: 100 })

  async function send(html: string): Promise<void> {
    const token = settings.get('notify.botToken')
    const chatId = settings.get('notify.chatId')
    if (!token || !chatId) return
    await sendBotMessage(fetchFn, token, chatId, html)
  }

  async function process(job: NotifyJob): Promise<void> {
    if (job.kind === 'code') {
      const [row] = await db
        .select({ code: codeMessages, account: accounts })
        .from(codeMessages)
        .innerJoin(accounts, eq(accounts.id, codeMessages.accountId))
        .where(eq(codeMessages.id, job.codeId))
      if (!row || row.code.notifiedAt) return
      await send(formatCodeMessage(row.account, row.code.code, row.code.text))
      await db.update(codeMessages).set({ notifiedAt: new Date() }).where(eq(codeMessages.id, job.codeId))
      return
    }
    if (job.kind === 'status') {
      const [account] = await db.select().from(accounts).where(eq(accounts.id, job.accountId))
      if (account) await send(formatStatusMessage(account, job.status, job.reason))
      return
    }
    if (job.proxyIds.length === 0) return
    const rows = await db
      .select({ id: proxies.id, host: proxies.host, port: proxies.port, expiresAt: proxies.expiresAt, account: accounts })
      .from(proxies)
      .leftJoin(accounts, eq(accounts.proxyId, proxies.id))
      .where(inArray(proxies.id, job.proxyIds))
      .orderBy(proxies.expiresAt, accounts.createdAt)
    // a reused proxy carries several accounts: one line per proxy
    const byProxy = new Map<string, { host: string; port: number; expiresAt: Date; accounts: AccountRow[] }>()
    for (const r of rows) {
      if (!r.expiresAt) continue
      const line = byProxy.get(r.id) ?? { host: r.host, port: r.port, expiresAt: r.expiresAt, accounts: [] }
      if (r.account) line.accounts.push(r.account)
      byProxy.set(r.id, line)
    }
    const list = [...byProxy.values()]
    if (list.length > 0) await send(formatProxyExpiringMessage(list))
  }

  return {
    process,
    /** CodeHooks.onCode: live codes always, caught-up ones only while still fresh (notify.maxAge) */
    async onCode(code: CodeRow, _account: AccountRow, live: boolean): Promise<void> {
      if (!wants('code')) return
      if (!live && Date.now() - code.date.getTime() > parseDuration(settings.get('notify.maxAge'))) return
      await enqueue({ kind: 'code', codeId: code.id })
    },
    /** AccountHooks.onStatusChanged */
    async onStatusChanged(account: AccountRow, _from: AccountStatus, to: AccountStatus): Promise<void> {
      const event = STATUS_EVENTS[to]
      if (event && wants(event)) await enqueue({ kind: 'status', accountId: account.id, status: to, reason: account.statusReason })
    },
    /** Housekeeping: one message listing the proxies whose paid period ends within proxy.expiryWarnDays. */
    async warnExpiringProxies(now = new Date()): Promise<number> {
      const until = new Date(now.getTime() + settings.get('proxy.expiryWarnDays') * 86_400_000)
      const due = await db
        .update(proxies)
        .set({ expiryWarnedAt: now })
        .where(and(isNotNull(proxies.expiresAt), lte(proxies.expiresAt, until), gt(proxies.expiresAt, now), isNull(proxies.expiryWarnedAt), ne(proxies.status, 'expired')))
        .returning({ id: proxies.id })
      if (due.length > 0 && wants('proxy_expiring')) await enqueue({ kind: 'proxyExpiring', proxyIds: due.map((d) => d.id) })
      return due.length
    },
    start(): void {
      worker = new Worker<NotifyJob>(NOTIFY_QUEUE, async (job: Job<NotifyJob>) => process(job.data), { connection: deps.queueRedis.duplicate(), prefix, concurrency: 1 })
      worker.on('failed', (job, err) => logger.warn({ err: err.message, kind: job?.data.kind }, 'notify: delivery failed'))
    },
    async stop(): Promise<void> {
      await worker?.close()
      await queue.close()
    },
  }
}
