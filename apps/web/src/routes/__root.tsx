import type { QueryClient } from '@tanstack/react-query'
import { createRootRouteWithContext, Outlet } from '@tanstack/react-router'
import { Toaster } from '@workspace/ui/components/toast'
import { TooltipProvider } from '@workspace/ui/components/tooltip'

export interface RouterContext {
  queryClient: QueryClient
}

export const Route = createRootRouteWithContext<RouterContext>()({
  component: () => (
    <TooltipProvider>
      <Toaster>
        <Outlet />
      </Toaster>
    </TooltipProvider>
  ),
})
