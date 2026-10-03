import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClientProvider } from '@tanstack/react-query'
import { createRouter, RouterProvider } from '@tanstack/react-router'
import '@workspace/ui/globals.css'
import { ThemeProvider } from '@/components/theme-provider.tsx'
import { createQueryClient } from '@/lib/query-client'
import { handleUnauthorized } from '@/lib/session'
import { routeTree } from './routeTree.gen'

const queryClient = createQueryClient(() => handleUnauthorized(queryClient, router))

const router = createRouter({
  routeTree,
  context: { queryClient },
  defaultPreload: 'intent',
  defaultPreloadStaleTime: 0,
  scrollRestoration: true,
})

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </ThemeProvider>
  </StrictMode>,
)
