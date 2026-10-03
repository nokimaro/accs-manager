import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider } from '@tanstack/react-router'
import '@workspace/ui/globals.css'
import { ThemeProvider } from '@/components/theme-provider.tsx'
import { createQueryClient } from '@/lib/query-client'
import { createAppRouter } from '@/lib/router'
import { handleUnauthorized } from '@/lib/session'
import { reloadOnStaleChunks } from '@/lib/stale-chunks'

reloadOnStaleChunks()

const queryClient = createQueryClient(() => handleUnauthorized(queryClient, router))
const router = createAppRouter(queryClient)

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </ThemeProvider>
  </StrictMode>,
)
