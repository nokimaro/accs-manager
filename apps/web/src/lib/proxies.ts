import { queryOptions } from '@tanstack/react-query'
import type { ProxyDto, ProxyStatus, ProxyStoreSyncStatus } from '@workspace/shared/proxies'
import { api } from './api'

export const proxiesQueryOptions = queryOptions({
  queryKey: ['proxies'] as const,
  queryFn: ({ signal }) => api<{ items: ProxyDto[] }>('/proxies', { signal }),
})

export const proxySyncStatusQueryOptions = queryOptions({
  queryKey: ['proxies', 'sync-status'] as const,
  queryFn: ({ signal }) => api<{ status: ProxyStoreSyncStatus | null }>('/proxies/sync-status', { signal }),
})

export const proxyStatusVariant: Record<ProxyStatus, 'secondary' | 'outline' | 'destructive'> = {
  ok: 'secondary',
  unchecked: 'outline',
  provisioning: 'outline',
  failing: 'outline',
  dead: 'destructive',
  expired: 'destructive',
}

/** Bound proxies first among equals: the filter groups of the proxies page. */
export const PROXY_STATUS_FILTERS = {
  all: null,
  ok: ['ok'],
  problems: ['failing', 'dead'],
  other: ['unchecked', 'provisioning', 'expired'],
} as const satisfies Record<string, readonly ProxyStatus[] | null>
export type ProxyStatusFilter = keyof typeof PROXY_STATUS_FILTERS
