import { queryOptions, type QueryClient } from '@tanstack/react-query'
import type { MeResponse } from '@workspace/shared/api'
import { api, ApiError } from './api'

export const authKeys = { me: ['auth', 'me'] as const, check: ['auth', 'check'] as const }

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

/**
 * Asks the server whether the session is still valid. Unlike `meQueryOptions` a 401 is an error here,
 * so it reaches the query cache's global 401 handler, which sends the admin to /login.
 * Other failures (network, 5xx) are ignored.
 */
export async function recheckSession(queryClient: QueryClient): Promise<void> {
  await queryClient
    .fetchQuery({ queryKey: authKeys.check, queryFn: ({ signal }) => api<MeResponse>('/auth/me', { signal }), staleTime: 0, gcTime: 0, retry: false })
    .catch(() => undefined)
}
