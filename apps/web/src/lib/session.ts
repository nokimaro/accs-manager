import type { QueryClient } from '@tanstack/react-query'
import { authKeys } from './auth'

/** Session expired or revoked: drop cached data and let the route guard send the admin to /login. */
export function handleUnauthorized(queryClient: QueryClient, router: { invalidate: () => Promise<unknown> }): void {
  if (queryClient.getQueryData(authKeys.me) == null) return
  queryClient.clear()
  queryClient.setQueryData(authKeys.me, null)
  void router.invalidate()
}
