import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router'
import { render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { routeTree } from '@/routeTree.gen'

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

function setup(path: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const router = createRouter({ routeTree, context: { queryClient }, history: createMemoryHistory({ initialEntries: [path] }) })
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
  return router
}

class SilentEventSource extends EventTarget {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSED = 2
  readyState = 0
  onerror: (() => void) | null = null
  close() {}
}

afterEach(() => vi.unstubAllGlobals())

it('redirects anonymous users to /login and keeps the target', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => json({ error: 'unauthorized' }, 401)))
  const router = setup('/settings?group=proxy')
  await waitFor(() => expect(router.state.location.pathname).toBe('/login'))
  expect(router.state.location.search).toEqual({ redirect: '/settings?group=proxy' })
  expect(await screen.findByRole('button', { name: 'Войти' })).toBeInTheDocument()
})

it('renders the shell with the active tab for signed-in admins', async () => {
  vi.stubGlobal('EventSource', SilentEventSource)
  vi.stubGlobal('fetch', vi.fn(async (url: string) => (url.endsWith('/auth/me') ? json({ id: 'a1', login: 'root' }) : json({ items: {} }))))
  setup('/')
  expect(await screen.findByRole('heading', { name: 'Коды' })).toBeInTheDocument()
  expect(screen.getAllByRole('tab', { name: 'Коды' })[0]).toHaveAttribute('aria-selected', 'true')
})
