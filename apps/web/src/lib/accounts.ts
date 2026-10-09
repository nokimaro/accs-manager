import { infiniteQueryOptions, queryOptions } from '@tanstack/react-query'
import { REUSE_PROXY, type AccountDto, type AccountSessionDto, type AccountStatus, type CloudPasswordInfoDto, type CodeDto } from '@workspace/shared/accounts'
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

/** Asks the worker (and Telegram) about the account's cloud password. */
export const cloudPasswordInfoQueryOptions = (id: string) =>
  queryOptions({
    queryKey: ['accounts', id, 'cloud-password'] as const,
    queryFn: ({ signal }) => api<CloudPasswordInfoDto>(`/accounts/${id}/cloud-password/info`, { signal }),
    retry: false,
  })

/** Live per-account data the worker fetches from Telegram on demand: not refetched on every account event. */
export const ON_DEMAND_ACCOUNT_QUERIES = ['sessions', 'cloud-password']

export const codesQueryOptions = (accountId?: string) =>
  queryOptions({
    queryKey: ['codes', accountId ?? 'all'] as const,
    queryFn: ({ signal }) => api<{ items: CodeDto[] }>(`/codes?limit=100${accountId ? `&accountId=${accountId}` : ''}`, { signal }),
  })

export const CODES_PAGE_SIZE = 50

/** The codes feed: newest first, «показать ещё» pages back by id. */
export const codesFeedQueryOptions = (accountId?: string) =>
  infiniteQueryOptions({
    queryKey: ['codes', accountId ?? 'all', 'feed'] as const,
    queryFn: ({ pageParam, signal }) => {
      const params = new URLSearchParams({ limit: String(CODES_PAGE_SIZE) })
      if (accountId) params.set('accountId', accountId)
      if (pageParam) params.set('before', String(pageParam))
      return api<{ items: CodeDto[] }>(`/codes?${params}`, { signal })
    },
    initialPageParam: null as number | null,
    getNextPageParam: (last) => (last.items.length === CODES_PAGE_SIZE ? last.items.at(-1)!.id : null),
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

/** Proxies an account may take: enabled, working, not yet checked or only failing — shared ones too. */
export function usableProxies(all: ProxyDto[], keepProxyId?: string | null): ProxyDto[] {
  return all.filter((p) => p.id === keepProxyId || (p.disabledAt === null && (p.status === 'ok' || p.status === 'unchecked' || p.status === 'failing')))
}

/** Usable proxies no account uses yet. */
export function freeProxies(all: ProxyDto[]): ProxyDto[] {
  return usableProxies(all).filter((p) => p.accounts.length === 0)
}

/** «Переиспользовать прокси»: the server takes the usable proxy with the fewest accounts, a random one among equals. */
export const REUSE_CHOICE = { value: REUSE_PROXY, label: 'Переиспользовать прокси — наименее загруженный' }

export function proxyLabel(p: Pick<ProxyDto, 'type' | 'host' | 'port' | 'tgCountry' | 'latencyMs'>): string {
  const extra = [p.tgCountry, p.latencyMs !== null ? `${p.latencyMs} мс` : null].filter(Boolean).join(', ')
  return `${p.type} ${p.host}:${p.port}${extra ? ` (${extra})` : ''}`
}
