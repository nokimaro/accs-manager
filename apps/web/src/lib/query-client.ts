import { MutationCache, QueryCache, QueryClient } from '@tanstack/react-query'
import { ApiError } from './api'

const isUnauthorized = (err: unknown) => err instanceof ApiError && err.status === 401

/** `onUnauthorized` runs when any query or mutation gets a 401 (expired or revoked session). */
export function createQueryClient(onUnauthorized: () => void = () => {}): QueryClient {
  return new QueryClient({
    queryCache: new QueryCache({ onError: (err) => isUnauthorized(err) && onUnauthorized() }),
    mutationCache: new MutationCache({ onError: (err) => isUnauthorized(err) && onUnauthorized() }),
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        refetchOnWindowFocus: false,
        retry: (count, err) => !(err instanceof ApiError && err.status < 500) && count < 2,
      },
    },
  })
}
