import type { QueryClient } from '@tanstack/react-query'
import { createRootRouteWithContext, HeadContent, Outlet } from '@tanstack/react-router'
import { Toaster } from '@workspace/ui/components/toast'
import { TooltipProvider } from '@workspace/ui/components/tooltip'
import { titleHead } from '@/lib/title'

export interface RouterContext {
  queryClient: QueryClient
}

export const Route = createRootRouteWithContext<RouterContext>()({
  // default «Панель | 159.team»; child routes override it (SPA: HeadContent hoists <title> into <head>)
  head: titleHead(),
  component: () => (
    <TooltipProvider>
      <HeadContent />
      <Toaster>
        <Outlet />
      </Toaster>
    </TooltipProvider>
  ),
})
