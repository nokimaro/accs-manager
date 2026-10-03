import { useQueryClient } from '@tanstack/react-query'
import { createFileRoute, Outlet, redirect } from '@tanstack/react-router'
import { toast } from '@workspace/ui/components/toast'
import { AppHeader } from '@/components/app-header'
import { accountsQueryOptions } from '@/lib/accounts'
import { emitAppEvent } from '@/lib/app-events'
import { meQueryOptions, recheckSession } from '@/lib/auth'
import { proxiesQueryOptions } from '@/lib/proxies'
import { settingsQueryOptions } from '@/lib/settings'
import { useEventStream } from '@/lib/use-event-stream'

export const Route = createFileRoute('/_authed')({
  beforeLoad: async ({ context, location }) => {
    const me = await context.queryClient.query({ ...meQueryOptions, staleTime: 'static' })
    if (!me) throw redirect({ to: '/login', search: { redirect: location.href } })
    return { me }
  },
  component: AuthedLayout,
})

function AuthedLayout() {
  const { me } = Route.useRouteContext()
  const queryClient = useQueryClient()
  const streamStatus = useEventStream({
    onEvent: (event) => {
      if (event.type === 'settings.changed') {
        void queryClient.invalidateQueries({ queryKey: settingsQueryOptions.queryKey })
        if (event.by !== me.id) toast.add({ title: 'Настройки изменены', description: 'Другой админ или CLI обновил настройки.' })
      }
      if (event.type === 'proxies.changed') void queryClient.invalidateQueries({ queryKey: proxiesQueryOptions.queryKey })
      // the list and the cards (['accounts', id]); sessions are re-read only on demand
      if (event.type === 'accounts.changed') void queryClient.invalidateQueries({ queryKey: accountsQueryOptions.queryKey, predicate: (q) => q.queryKey[2] !== 'sessions' })
      if (event.type === 'code.new') {
        void queryClient.invalidateQueries({ queryKey: ['codes'] })
        void queryClient.invalidateQueries({ queryKey: accountsQueryOptions.queryKey, predicate: (q) => q.queryKey[2] !== 'sessions' })
      }
      emitAppEvent(event)
    },
    // a revoked session ends at the global 401 handler (→ /login)
    onSessionLost: () => void recheckSession(queryClient),
    // events sent while the stream was down are lost: refetch what is on screen
    onReconnect: () => void queryClient.invalidateQueries(),
  })
  return (
    <div className="flex min-h-svh flex-col">
      <AppHeader login={me.login} streamStatus={streamStatus} />
      <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-6 md:px-6">
        <Outlet />
      </main>
    </div>
  )
}
