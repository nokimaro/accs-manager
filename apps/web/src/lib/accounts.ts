import { queryOptions } from '@tanstack/react-query'
import type { AccountDto, AccountSessionDto, AccountStatus, CodeDto } from '@workspace/shared/accounts'
import type { ProxyDto } from '@workspace/shared/proxies'
import { api } from './api'

export const accountsQueryOptions = queryOptions({
  queryKey: ['accounts'] as const,
  queryFn: ({ signal }) => api<{ items: AccountDto[] }>('/accounts', { signal }),
})

export const accountQueryOptions = (id: string) =>
  queryOptions({
    queryKey: ['accounts', id] as const,
    queryFn: ({ signal }) => api<AccountDto>(`/accounts/${id}`, { signal }),
  })

/** Asks the worker (and Telegram) — fetched only when the admin opens the list. */
export const accountSessionsQueryOptions = (id: string) =>
  queryOptions({
    queryKey: ['accounts', id, 'sessions'] as const,
    queryFn: ({ signal }) => api<{ items: AccountSessionDto[] }>(`/accounts/${id}/sessions`, { signal }),
    retry: false,
  })

export const codesQueryOptions = (accountId?: string) =>
  queryOptions({
    queryKey: ['codes', accountId ?? 'all'] as const,
    queryFn: ({ signal }) => api<{ items: CodeDto[] }>(`/codes?limit=100${accountId ? `&accountId=${accountId}` : ''}`, { signal }),
  })

export const accountStatusVariant: Record<AccountStatus, 'secondary' | 'outline' | 'destructive'> = {
  active: 'secondary',
  pending_check: 'outline',
  paused: 'outline',
  frozen: 'outline',
  proxy_down: 'destructive',
  error: 'destructive',
  unauthorized: 'destructive',
  banned: 'destructive',
}

export const ACCOUNT_STATUS_FILTERS = {
  all: null,
  active: ['active', 'frozen'],
  problems: ['proxy_down', 'error', 'unauthorized', 'banned'],
  other: ['pending_check', 'paused'],
} as const satisfies Record<string, readonly AccountStatus[] | null>
export type AccountStatusFilter = keyof typeof ACCOUNT_STATUS_FILTERS

/** Proxies an account may take: enabled, working or not yet checked, not used by another account. */
export function freeProxies(all: ProxyDto[], keepProxyId?: string | null): ProxyDto[] {
  return all.filter(
    (p) => p.id === keepProxyId || (p.disabledAt === null && p.account === null && (p.status === 'ok' || p.status === 'unchecked' || p.status === 'failing')),
  )
}

export function proxyLabel(p: Pick<ProxyDto, 'type' | 'host' | 'port' | 'tgCountry' | 'latencyMs'>): string {
  const extra = [p.tgCountry, p.latencyMs !== null ? `${p.latencyMs} мс` : null].filter(Boolean).join(', ')
  return `${p.type} ${p.host}:${p.port}${extra ? ` (${extra})` : ''}`
}
