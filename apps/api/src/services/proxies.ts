import { accounts, proxies, type Db } from '@workspace/db'
import type { Cipher } from '@workspace/shared/crypto'
import {
  parseProxyList,
  proxyEndpointKey,
  type CreateProxyInput,
  type ImportProxiesInput,
  type ImportProxiesPreview,
  type ImportProxiesResult,
  type ProxyDto,
  type UpdateProxyInput,
} from '@workspace/shared/proxies'
import { eq, getTableColumns } from 'drizzle-orm'
import { DomainError } from '../lib/errors.ts'

type ProxyRow = typeof proxies.$inferSelect
type AccountRef = { id: string; label: string | null; phone: string | null; username: string | null } | null

const iso = (d: Date | null) => (d ? d.toISOString() : null)

export function toProxyDto(row: ProxyRow, account: AccountRef): ProxyDto {
  return {
    id: row.id,
    source: row.source,
    externalId: row.externalId,
    type: row.type,
    host: row.host,
    port: row.port,
    username: row.username,
    hasPassword: row.passwordEnc !== null,
    tag: row.tag,
    status: row.status,
    lastCheckAt: iso(row.lastCheckAt),
    lastOkAt: iso(row.lastOkAt),
    latencyMs: row.latencyMs,
    tgCountry: row.tgCountry,
    lastError: row.lastError,
    failStreak: row.failStreak,
    expiresAt: iso(row.expiresAt),
    disabledAt: iso(row.disabledAt),
    createdAt: row.createdAt.toISOString(),
    account,
  }
}

function selectWithAccount(db: Db) {
  return db
    .select({
      proxy: getTableColumns(proxies),
      account: { id: accounts.id, label: accounts.label, phone: accounts.phone, username: accounts.username },
    })
    .from(proxies)
    .leftJoin(accounts, eq(accounts.proxyId, proxies.id))
}

export async function listProxies(db: Db): Promise<ProxyDto[]> {
  const rows = await selectWithAccount(db).orderBy(proxies.createdAt)
  return rows.map((r) => toProxyDto(r.proxy, r.account?.id ? r.account : null))
}

export async function getProxy(db: Db, id: string): Promise<ProxyDto> {
  const [row] = await selectWithAccount(db).where(eq(proxies.id, id))
  if (!row) throw new DomainError(404, 'not_found', 'Прокси не найден')
  return toProxyDto(row.proxy, row.account?.id ? row.account : null)
}

const isUniqueViolation = (err: unknown) => (err as { cause?: { code?: string }; code?: string })?.cause?.code === '23505' || (err as { code?: string })?.code === '23505'

export async function createProxy(db: Db, cipher: Cipher, input: CreateProxyInput): Promise<ProxyDto> {
  try {
    const [row] = await db
      .insert(proxies)
      .values({
        source: 'manual',
        type: input.type,
        host: input.host,
        port: input.port,
        username: input.username || null,
        passwordEnc: input.password ? cipher.encrypt(input.password) : null,
        tag: input.tag ?? null,
      })
      .returning()
    return toProxyDto(row!, null)
  } catch (err) {
    if (isUniqueViolation(err)) throw new DomainError(409, 'proxy_exists', 'Такой прокси уже есть в пуле')
    throw err
  }
}

async function existingEndpointKeys(db: Db): Promise<Set<string>> {
  const rows = await db.select({ type: proxies.type, host: proxies.host, port: proxies.port, username: proxies.username }).from(proxies)
  return new Set(rows.map(proxyEndpointKey))
}

export async function previewProxyImport(db: Db, input: ImportProxiesInput): Promise<ImportProxiesPreview> {
  const parsed = parseProxyList(input.text, input.defaultType)
  const existing = await existingEndpointKeys(db)
  const preview: ImportProxiesPreview = { proxies: [], errors: parsed.errors, duplicates: parsed.repeated.map((r) => ({ ...r, reason: 'repeated' as const })) }
  const lines = input.text.split(/\r?\n/)
  for (const p of parsed.proxies) {
    if (existing.has(proxyEndpointKey(p))) {
      preview.duplicates.push({ line: p.line, text: lines[p.line - 1]!.trim(), reason: 'exists' })
    } else {
      preview.proxies.push({ line: p.line, type: p.type, host: p.host, port: p.port, username: p.username ?? null })
    }
  }
  preview.duplicates.sort((a, b) => a.line - b.line)
  return preview
}

export async function importProxies(db: Db, cipher: Cipher, input: ImportProxiesInput): Promise<ImportProxiesResult & { ids: string[] }> {
  const parsed = parseProxyList(input.text, input.defaultType)
  if (parsed.proxies.length === 0) return { created: 0, skipped: parsed.repeated.length, ids: [] }
  const rows = await db
    .insert(proxies)
    .values(
      parsed.proxies.map((p) => ({
        source: 'manual' as const,
        type: p.type,
        host: p.host,
        port: p.port,
        username: p.username ?? null,
        passwordEnc: p.password ? cipher.encrypt(p.password) : null,
        tag: input.tag ?? null,
      })),
    )
    .onConflictDoNothing()
    .returning({ id: proxies.id })
  return { created: rows.length, skipped: parsed.proxies.length - rows.length + parsed.repeated.length, ids: rows.map((r) => r.id) }
}

export async function updateProxy(db: Db, id: string, input: UpdateProxyInput): Promise<ProxyDto> {
  const current = await getProxy(db, id)
  const set: Partial<typeof proxies.$inferInsert> = {}
  if (input.tag !== undefined) set.tag = input.tag
  if (input.disabled !== undefined && input.disabled !== (current.disabledAt !== null)) {
    // a bound account would silently lose its proxy: change the account's proxy first
    if (input.disabled && current.account) throw new DomainError(409, 'proxy_in_use', 'Прокси привязан к аккаунту — сначала смените прокси у аккаунта')
    set.disabledAt = input.disabled ? new Date() : null
  }
  if (Object.keys(set).length > 0) await db.update(proxies).set(set).where(eq(proxies.id, id))
  return getProxy(db, id)
}

export async function deleteProxy(db: Db, id: string): Promise<void> {
  const proxy = await getProxy(db, id)
  if (proxy.account) throw new DomainError(409, 'proxy_in_use', 'Прокси привязан к аккаунту — сначала смените прокси у аккаунта')
  if (proxy.source === 'proxy_store') {
    throw new DomainError(409, 'managed_by_sync', 'Прокси из proxy-store управляется синхронизацией — его можно только отключить')
  }
  await db.delete(proxies).where(eq(proxies.id, id))
}
