import { queryOptions } from '@tanstack/react-query'
import type { SettingsResponse } from '@workspace/shared/api'
import { api } from './api'

export const settingsQueryOptions = queryOptions({
  queryKey: ['settings'] as const,
  queryFn: ({ signal }) => api<SettingsResponse>('/settings', { signal }),
})
