import { queryOptions } from '@tanstack/react-query'
import type { MeResponse } from '@workspace/shared/api'
import { api, ApiError } from './api'

export const authKeys = { me: ['auth', 'me'] as const }

/** 401 is an expected state → resolves to null. */
export const meQueryOptions = queryOptions({
  queryKey: authKeys.me,
  queryFn: async ({ signal }): Promise<MeResponse | null> => {
    try {
      return await api<MeResponse>('/auth/me', { signal })
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return null
      throw err
    }
  },
  staleTime: 5 * 60_000,
  retry: false,
})
