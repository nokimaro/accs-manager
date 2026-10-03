import { eq, proxies } from '@workspace/db'
import type { Redis } from '@workspace/server'
import { PROXY_STORE_STATUS_KEY, proxyEndpointKey, proxyStoreSyncStatus, type ProxyStoreSyncStatus } from '@workspace/shared/proxies'
import { z } from 'zod'
import type { WorkerDeps } from '../deps.ts'

const itemSchema = z.object({
  id: z.coerce.string(),
  ip: z.string(),
  port: z.coerce.string(),
  user: z.string().nullish(),
  pass: z.string().nullish(),
  type: z.string(),
  country: z.string(),
  category: z.string().nullish(),
  active: z.coerce.string(),
  unixtime_end: z.coerce.number().nullish(),
  order_id: z.coerce.string().nullish(),
  autoprolong: z.coerce.string().nullish(),
  comment: z.string().nullish(),
})
export type ProxyStoreItem = z.output<typeof itemSchema>

/** `{ status: 'ok', list: { "<id>": {...} } }`; an empty list may come as `[]`. */
export const proxyStoreResponse = z.object({
  status: z.string(),
  list: z.union([z.record(z.string(), itemSchema), z.array(itemSchema)]).optional(),
  error: z.string().optional(),
})

export interface MappedProxy {
  externalId: string
  type: 'socks5' | 'http'
  host: string
  port: number
  username: string | null
  password: string | null
  /** bought but not issued yet: ip 0.0.0.0 / port 0 */
  provisioning: boolean
  expiresAt: Date | null
  meta: { orderId: string | null; autoprolong: boolean; comment: string | null }
}

/** Active proxies of the configured country and category, in our terms. */
export function mapProxyStoreList(list: ProxyStoreItem[], filter: { country: string; category: string }): MappedProxy[] {
  return list
    .filter((p) => p.active === '1' && p.country.toLowerCase() === filter.country && (p.category ?? '') === filter.category)
    .filter((p) => p.type === 'socks' || p.type === 'http')
    .map((p) => {
      const port = Number(p.port)
      return {
        externalId: p.id,
        type: p.type === 'socks' ? 'socks5' : 'http',
        host: p.ip,
        port,
        username: p.user || null,
        password: p.pass || null,
        provisioning: p.ip === '0.0.0.0' || port === 0,
        expiresAt: p.unixtime_end ? new Date(p.unixtime_end * 1000) : null,
        meta: { orderId: p.order_id ?? null, autoprolong: p.autoprolong === '1', comment: p.comment || null },
      }
    })
}

export type ProxyStoreFetch = (url: string, init: { signal: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>

export async function fetchProxyStoreList(fetchFn: ProxyStoreFetch, apiKey: string): Promise<ProxyStoreItem[]> {
  const res = await fetchFn(`https://proxy-store.com/api/${encodeURIComponent(apiKey)}/getproxy/`, { signal: AbortSignal.timeout(20_000) })
  if (!res.ok) throw new Error(`proxy-store answered HTTP ${res.status}`)
  const body = proxyStoreResponse.parse(await res.json())
  if (body.status !== 'ok') throw new Error(`proxy-store: ${body.error ?? body.status}`)
  if (!body.list) return []
  return Array.isArray(body.list) ? body.list : Object.values(body.list)
}

export type SyncResult = ProxyStoreSyncStatus

export interface ProxyStoreHooks {
  /** a bound proxy changed address or credentials: its account must reconnect */
  onChanged?: (proxyId: string) => Promise<void> | void
  /** a proxy vanished from the provider: accounts on it stop */
  onDown?: (proxyId: string) => Promise<void> | void
}

/** Last sync outcome (the api shows it on the proxies page). */
export async function readSyncStatus(redis: Redis, key = PROXY_STORE_STATUS_KEY): Promise<SyncResult | null> {
  const raw = await redis.get(key)
  return raw ? proxyStoreSyncStatus.parse(JSON.parse(raw)) : null
}

/**
 * Brings `source = 'proxy_store'` rows in line with the provider. Manual proxies are never touched.
 * Returns null when the sync is off or has no API key.
 */
export async function syncProxyStore(
  deps: WorkerDeps,
  fetchFn: ProxyStoreFetch,
  hooks: ProxyStoreHooks = {},
  /** tests sharing one Redis pass their own key */
  statusKey = PROXY_STORE_STATUS_KEY,
): Promise<SyncResult | null> {
  const { db, cipher, settings, logger, bus, redis } = deps
  const apiKey = settings.get('proxyStore.apiKey')
  if (!settings.get('proxyStore.enabled') || !apiKey) return null

  const result: SyncResult = { at: new Date().toISOString(), ok: true, created: 0, updated: 0, expired: 0, skipped: 0 }
  const changedIds: string[] = []
  try {
    const items = await fetchProxyStoreList(fetchFn, apiKey)
    const wanted = mapProxyStoreList(items, { country: settings.get('proxyStore.country'), category: settings.get('proxyStore.category') })
    const existing = await db.select().from(proxies).where(eq(proxies.source, 'proxy_store'))
    const byExternalId = new Map(existing.map((row) => [row.externalId, row]))
    const manualEndpoints = new Set(
      (await db.select().from(proxies).where(eq(proxies.source, 'manual'))).map((row) => proxyEndpointKey(row)),
    )

    for (const p of wanted) {
      const row = byExternalId.get(p.externalId)
      byExternalId.delete(p.externalId)
      const issuedStatus = p.provisioning ? ('provisioning' as const) : ('unchecked' as const)
      if (!row) {
        if (!p.provisioning && manualEndpoints.has(proxyEndpointKey(p))) {
          result.skipped++
          continue
        }
        const [inserted] = await db
          .insert(proxies)
          .values({
            source: 'proxy_store',
            externalId: p.externalId,
            type: p.type,
            host: p.host,
            port: p.port,
            username: p.username,
            passwordEnc: p.password ? cipher.encrypt(p.password) : null,
            status: issuedStatus,
            expiresAt: p.expiresAt,
            providerMeta: p.meta,
          })
          .onConflictDoNothing()
          .returning({ id: proxies.id })
        if (inserted) {
          result.created++
          changedIds.push(inserted.id)
        } else result.skipped++
        continue
      }
      const password = row.passwordEnc ? cipher.decrypt(row.passwordEnc) : null
      const endpointChanged = row.type !== p.type || row.host !== p.host || row.port !== p.port || row.username !== p.username || password !== p.password
      const renewed = row.status === 'expired' && (!p.expiresAt || p.expiresAt > new Date())
      if (endpointChanged || renewed) {
        await db
          .update(proxies)
          .set({
            type: p.type,
            host: p.host,
            port: p.port,
            username: p.username,
            passwordEnc: p.password ? cipher.encrypt(p.password) : null,
            status: issuedStatus,
            failStreak: 0,
            lastCheckAt: null,
            lastError: null,
            ...(endpointChanged ? { tgCountry: null, tgCheckedAt: null, latencyMs: null } : {}),
            expiresAt: p.expiresAt,
            providerMeta: p.meta,
          })
          .where(eq(proxies.id, row.id))
        result.updated++
        changedIds.push(row.id)
        if (endpointChanged) await hooks.onChanged?.(row.id)
      } else if (row.expiresAt?.getTime() !== p.expiresAt?.getTime()) {
        await db.update(proxies).set({ expiresAt: p.expiresAt, expiryWarnedAt: null, providerMeta: p.meta }).where(eq(proxies.id, row.id))
        changedIds.push(row.id)
      }
    }

    // gone from the provider (cancelled, not renewed): expired; accounts on it stop
    for (const row of byExternalId.values()) {
      if (row.status === 'expired') continue
      await db.update(proxies).set({ status: 'expired' }).where(eq(proxies.id, row.id))
      result.expired++
      changedIds.push(row.id)
      await hooks.onDown?.(row.id)
    }
  } catch (err) {
    result.ok = false
    // the API key is part of the URL: never let it reach the log or the panel
    result.error = (err instanceof Error ? err.message : String(err)).replaceAll(apiKey, '***').slice(0, 300)
    logger.warn({ error: result.error }, 'proxy-store: sync failed')
  }
  await redis.set(statusKey, JSON.stringify(result))
  if (changedIds.length > 0) await bus.publish({ type: 'proxies.changed', ids: changedIds })
  return result
}
