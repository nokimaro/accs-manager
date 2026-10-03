import { z } from 'zod'

export const PROXY_TYPES = ['socks5', 'http'] as const
export type ProxyType = (typeof PROXY_TYPES)[number]

export const PROXY_SOURCES = ['manual', 'proxy_store'] as const
export type ProxySource = (typeof PROXY_SOURCES)[number]

export const PROXY_STATUSES = ['provisioning', 'unchecked', 'ok', 'failing', 'dead', 'expired'] as const
export type ProxyStatus = (typeof PROXY_STATUSES)[number]

export const proxyStatusLabels: Record<ProxyStatus, string> = {
  provisioning: 'выдаётся',
  unchecked: 'не проверен',
  ok: 'работает',
  failing: 'сбоит',
  dead: 'не работает',
  expired: 'истёк',
}

export const proxySourceLabels: Record<ProxySource, string> = { manual: 'вручную', proxy_store: 'proxy-store' }

// ---- parsing proxy lists ----

export interface ParsedProxy {
  type: ProxyType
  host: string
  port: number
  username?: string
  password?: string
}

export type ProxyLineResult = { ok: true; proxy: ParsedProxy } | { ok: false; reason: string }

const SCHEMES: Record<string, ProxyType> = { socks5: 'socks5', socks5h: 'socks5', socks: 'socks5', http: 'http' }
const HOST_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i

const fail = (reason: string): ProxyLineResult => ({ ok: false, reason })

function parseHostPort(value: string): { host: string; port: number } | string {
  const match = /^(.+):(\d+)$/.exec(value)
  if (!match) return 'Ожидается host:port'
  const port = Number(match[2])
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return 'Порт — число от 1 до 65535'
  const host = match[1]!.toLowerCase()
  if (!HOST_RE.test(host)) return 'Некорректный адрес'
  return { host, port }
}

function withCredentials(type: ProxyType, hostPort: string, username: string, password: string): ProxyLineResult {
  const endpoint = parseHostPort(hostPort)
  if (typeof endpoint === 'string') return fail(endpoint)
  return { ok: true, proxy: { type, ...endpoint, ...(username ? { username } : {}), ...(password ? { password } : {}) } }
}

/**
 * One proxy per line in any of: `socks5://user:pass@host:port`, `http://host:port`, `host:port`,
 * `host:port:user:pass`, `user:pass@host:port`. Lines without a scheme get `defaultType`.
 */
export function parseProxyLine(raw: string, defaultType: ProxyType): ProxyLineResult {
  const line = raw.trim()
  const scheme = /^([a-z0-9]+):\/\//i.exec(line)
  if (scheme) {
    const name = scheme[1]!.toLowerCase()
    const type = SCHEMES[name]
    if (!type) return fail(`Неизвестная схема ${name} — нужна socks5 или http`)
    const rest = line.slice(scheme[0].length)
    const at = rest.lastIndexOf('@')
    if (at < 0) return withCredentials(type, rest, '', '')
    const creds = rest.slice(0, at)
    const colon = creds.indexOf(':')
    return withCredentials(type, rest.slice(at + 1), colon < 0 ? creds : creds.slice(0, colon), colon < 0 ? '' : creds.slice(colon + 1))
  }
  // host:port:user:pass — checked first: the password may itself contain '@' or ':'
  const hostPortCreds = /^([^:@\s]+):(\d+):(.*)$/.exec(line)
  if (hostPortCreds) {
    const creds = hostPortCreds[3]!
    const colon = creds.indexOf(':')
    if (colon <= 0) return fail('Ожидается host:port:логин:пароль')
    return withCredentials(defaultType, `${hostPortCreds[1]}:${hostPortCreds[2]}`, creds.slice(0, colon), creds.slice(colon + 1))
  }
  const at = line.lastIndexOf('@')
  if (at >= 0) {
    const creds = line.slice(0, at)
    const colon = creds.indexOf(':')
    return withCredentials(defaultType, line.slice(at + 1), colon < 0 ? creds : creds.slice(0, colon), colon < 0 ? '' : creds.slice(colon + 1))
  }
  return withCredentials(defaultType, line, '', '')
}

/** Identity of a proxy in the pool: type, host, port and login (the password is not part of it). */
export function proxyEndpointKey(p: { type: ProxyType; host: string; port: number; username?: string | null }): string {
  return `${p.type}://${p.username ? `${p.username}@` : ''}${p.host.toLowerCase()}:${p.port}`
}

export interface ProxyListResult {
  proxies: (ParsedProxy & { line: number })[]
  errors: { line: number; text: string; reason: string }[]
  /** the same endpoint earlier in the list */
  repeated: { line: number; text: string }[]
}

/** Parses a pasted list or .txt file: blank lines and `#` comments are skipped. */
export function parseProxyList(text: string, defaultType: ProxyType): ProxyListResult {
  const result: ProxyListResult = { proxies: [], errors: [], repeated: [] }
  const seen = new Set<string>()
  text.split(/\r?\n/).forEach((raw, index) => {
    const line = index + 1
    const trimmed = raw.trim()
    if (!trimmed || trimmed.startsWith('#')) return
    const parsed = parseProxyLine(trimmed, defaultType)
    if (!parsed.ok) {
      result.errors.push({ line, text: trimmed, reason: parsed.reason })
      return
    }
    const key = proxyEndpointKey(parsed.proxy)
    if (seen.has(key)) {
      result.repeated.push({ line, text: trimmed })
      return
    }
    seen.add(key)
    result.proxies.push({ ...parsed.proxy, line })
  })
  return result
}

// ---- API ----

export const proxyAccountRef = z.object({ id: z.string(), label: z.string().nullable(), phone: z.string().nullable(), username: z.string().nullable() })

export const proxyDto = z.object({
  id: z.string(),
  source: z.enum(PROXY_SOURCES),
  externalId: z.string().nullable(),
  type: z.enum(PROXY_TYPES),
  host: z.string(),
  port: z.number(),
  username: z.string().nullable(),
  /** the password itself is never returned */
  hasPassword: z.boolean(),
  tag: z.string().nullable(),
  status: z.enum(PROXY_STATUSES),
  lastCheckAt: z.string().nullable(),
  lastOkAt: z.string().nullable(),
  latencyMs: z.number().nullable(),
  tgCountry: z.string().nullable(),
  lastError: z.string().nullable(),
  failStreak: z.number(),
  expiresAt: z.string().nullable(),
  disabledAt: z.string().nullable(),
  createdAt: z.string(),
  account: proxyAccountRef.nullable(),
})
export type ProxyDto = z.output<typeof proxyDto>

const hostSchema = z.string().trim().toLowerCase().regex(HOST_RE, 'Некорректный адрес')
const tagSchema = z.string().trim().max(64).nullable().optional()

export const createProxyInput = z.object({
  type: z.enum(PROXY_TYPES),
  host: hostSchema,
  port: z.coerce.number().int().min(1, 'Порт — число от 1 до 65535').max(65_535, 'Порт — число от 1 до 65535'),
  username: z.string().trim().max(256).optional(),
  password: z.string().max(256).optional(),
  tag: tagSchema,
})
export type CreateProxyInput = z.output<typeof createProxyInput>

export const updateProxyInput = z.object({ tag: tagSchema, disabled: z.boolean().optional() })
export type UpdateProxyInput = z.output<typeof updateProxyInput>

export const importProxiesInput = z.object({
  text: z.string().max(1_000_000),
  defaultType: z.enum(PROXY_TYPES),
  tag: tagSchema,
})
export type ImportProxiesInput = z.output<typeof importProxiesInput>

export const importProxiesPreview = z.object({
  /** new endpoints, without passwords */
  proxies: z.array(z.object({ line: z.number(), type: z.enum(PROXY_TYPES), host: z.string(), port: z.number(), username: z.string().nullable() })),
  errors: z.array(z.object({ line: z.number(), text: z.string(), reason: z.string() })),
  /** repeated in the list or already in the pool */
  duplicates: z.array(z.object({ line: z.number(), text: z.string(), reason: z.enum(['repeated', 'exists']) })),
})
export type ImportProxiesPreview = z.output<typeof importProxiesPreview>

export const importProxiesResult = z.object({ created: z.number(), skipped: z.number() })
export type ImportProxiesResult = z.output<typeof importProxiesResult>

// ---- proxy-store sync status (written by the worker, read by the api) ----

export const PROXY_STORE_STATUS_KEY = 'accs:proxy-store:last-sync'

export const proxyStoreSyncStatus = z.object({
  at: z.string(),
  ok: z.boolean(),
  error: z.string().optional(),
  created: z.number(),
  updated: z.number(),
  expired: z.number(),
  skipped: z.number(),
})
export type ProxyStoreSyncStatus = z.output<typeof proxyStoreSyncStatus>
