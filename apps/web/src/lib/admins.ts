import { queryOptions } from '@tanstack/react-query'
import type { AdminDto } from '@workspace/shared/api'
import { api } from './api'

export const adminsQueryOptions = queryOptions({
  queryKey: ['admins'] as const,
  queryFn: ({ signal }) => api<{ items: AdminDto[] }>('/admins', { signal }),
})
