import { and, eq, isNull, lte, ne, notInArray, proxies } from '@workspace/db'
import { parseDuration } from '@workspace/shared/duration'
import type { ProxyStatus } from '@workspace/shared/proxies'
import type { WorkerDeps } from '../deps.ts'
import type { ProxyChecker, ProxyEndpoint } from './checker.ts'

type ProxyRow = typeof proxies.$inferSelect

/** Failing proxies are re-checked this often, ahead of their normal interval. */
export const FAILING_RECHECK_MS = 60_000
/** The country check costs a real MTProto exchange: at most once a day per proxy. */
export const COUNTRY_RECHECK_MS = 24 * 3_600_000
const CONCURRENCY = 5

export function isDue(row: Pick<ProxyRow, 'status' | 'lastCheckAt'>, now: Date, intervalMs: number): boolean {
  if (!row.lastCheckAt) return true
  const age = now.getTime() - row.lastCheckAt.getTime()
  return age >= (row.status === 'failing' ? FAILING_RECHECK_MS : intervalMs)
}

export function needsCountry(row: Pick<ProxyRow, 'tgCountry' | 'tgCheckedAt'>, now: Date): boolean {
  return !row.tgCountry || !row.tgCheckedAt || now.getTime() - row.tgCheckedAt.getTime() >= COUNTRY_RECHECK_MS
}

/** Error text for the panel: never the proxy credentials. */
export function sanitizeProxyError(err: unknown, proxy: Pick<ProxyEndpoint, 'username' | 'password'>): string {
  let message = err instanceof Error ? err.message : String(err)
  for (const secret of [proxy.password, proxy.username]) if (secret) message = message.replaceAll(secret, '***')
  return message.slice(0, 300)
}

export interface ProxyHealthHooks {
  /** the proxy became dead or expired: accounts on it must stop */
  onDown?: (proxyId: string) => Promise<void> | void
  /** the proxy works again: accounts stopped because of it may resume */
  onUp?: (proxyId: string) => Promise<void> | void
}

export interface ProxyHealth {
  /** maintenance tick: expire overdue proxies, check those that are due */
  checkDue(now?: Date): Promise<number>
  /** check one proxy now, whatever its schedule */
  checkById(id: string): Promise<ProxyStatus | null>
}

export function createProxyHealth(deps: WorkerDeps, checker: ProxyChecker, hooks: ProxyHealthHooks = {}): ProxyHealth {
  const { db, cipher, settings, logger, bus } = deps

  const endpoint = (row: ProxyRow): ProxyEndpoint => ({
    type: row.type,
    host: row.host,
    port: row.port,
    username: row.username,
    password: row.passwordEnc ? cipher.decrypt(row.passwordEnc) : null,
  })

  async function check(row: ProxyRow, now: Date): Promise<ProxyStatus> {
    const proxy = endpoint(row)
    const previous = row.status
    let next: ProxyStatus
    try {
      const latencyMs = await checker.tunnel(proxy)
      const update: Partial<typeof proxies.$inferInsert> = { status: 'ok', latencyMs, lastCheckAt: now, lastOkAt: now, failStreak: 0, lastError: null }
      if (needsCountry(row, now)) {
        try {
          update.tgCountry = await checker.country(proxy)
          update.tgCheckedAt = now
        } catch (err) {
          // the tunnel works: a failed country lookup is not a proxy failure
          logger.warn({ proxyId: row.id, err: sanitizeProxyError(err, proxy) }, 'proxy: country check failed')
        }
      }
      await db.update(proxies).set(update).where(eq(proxies.id, row.id))
      next = 'ok'
    } catch (err) {
      const failStreak = row.failStreak + 1
      next = failStreak >= settings.get('proxy.failThreshold') ? 'dead' : 'failing'
      await db
        .update(proxies)
        .set({ status: next, failStreak, lastCheckAt: now, lastError: sanitizeProxyError(err, proxy) })
        .where(eq(proxies.id, row.id))
    }
    if (next === 'dead' && previous !== 'dead') await hooks.onDown?.(row.id)
    if (next === 'ok' && previous !== 'ok') await hooks.onUp?.(row.id)
    return next
  }

  async function runAll(rows: ProxyRow[], now: Date): Promise<void> {
    const queue = [...rows]
    await Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
        for (let row = queue.shift(); row; row = queue.shift()) {
          await check(row, now).catch((err: unknown) => logger.error({ err, proxyId: row!.id }, 'proxy: check crashed'))
        }
      }),
    )
  }

  return {
    async checkDue(now = new Date()) {
      // overdue paid proxies end here even if the provider still lists them
      const expired = await db
        .update(proxies)
        .set({ status: 'expired' })
        .where(and(lte(proxies.expiresAt, now), ne(proxies.status, 'expired')))
        .returning({ id: proxies.id })
      for (const { id } of expired) await hooks.onDown?.(id)

      const candidates = await db
        .select()
        .from(proxies)
        .where(and(isNull(proxies.disabledAt), notInArray(proxies.status, ['provisioning', 'expired'])))
      const intervalMs = parseDuration(settings.get('proxy.checkInterval'))
      const due = candidates.filter((row) => isDue(row, now, intervalMs))
      await runAll(due, now)
      const changed = [...expired.map((e) => e.id), ...due.map((d) => d.id)]
      if (changed.length > 0) await bus.publish({ type: 'proxies.changed', ids: changed })
      return due.length
    },
    async checkById(id) {
      const [row] = await db.select().from(proxies).where(and(eq(proxies.id, id), notInArray(proxies.status, ['provisioning', 'expired'])))
      if (!row) return null
      const status = await check(row, new Date())
      await bus.publish({ type: 'proxies.changed', ids: [id] })
      return status
    },
  }
}

