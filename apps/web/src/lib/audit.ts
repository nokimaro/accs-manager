import { keepPreviousData, queryOptions } from '@tanstack/react-query'
import type { AuditPage } from '@workspace/shared/api'
import { api } from './api'

export type AuditPeriod = '24h' | '7d' | '30d' | 'all'
export interface AuditFilters {
  page: number
  pageSize: number
  action?: string
  adminId?: string
  period: AuditPeriod
}

const PERIOD_MS: Record<Exclude<AuditPeriod, 'all'>, number> = { '24h': 86_400_000, '7d': 7 * 86_400_000, '30d': 30 * 86_400_000 }

export const auditQueryOptions = (f: AuditFilters) =>
  queryOptions({
    queryKey: ['audit', f] as const,
    queryFn: ({ signal }) => {
      const qs = new URLSearchParams({ page: String(f.page), pageSize: String(f.pageSize) })
      if (f.action) qs.set('action', f.action)
      if (f.adminId) qs.set('adminId', f.adminId)
      if (f.period !== 'all') qs.set('from', new Date(Date.now() - PERIOD_MS[f.period]).toISOString())
      return api<AuditPage>(`/audit?${qs}`, { signal })
    },
    placeholderData: keepPreviousData,
  })
