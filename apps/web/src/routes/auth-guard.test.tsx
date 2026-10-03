import { QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, RouterProvider } from '@tanstack/react-router'
import { render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { createQueryClient } from '@/lib/query-client'
import { createAppRouter } from '@/lib/router'
import { handleUnauthorized } from '@/lib/session'

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

/** API of a signed-in admin with nothing configured yet: settings are a map, every list is empty. */
const signedIn = (url: string) => {
  if (url.endsWith('/auth/me')) return json({ id: 'a1', login: 'root' })
  if (url.endsWith('/settings')) return json({ items: {} })
  return json({ items: [] })
}

function setup(path: string) {
  const queryClient = createQueryClient(() => handleUnauthorized(queryClient, router))
  const router = createAppRouter(queryClient, createMemoryHistory({ initialEntries: [path] }))
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
  return { router, queryClient }
}

class SilentEventSource extends EventTarget {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSED = 2
  readyState = 0
  onerror: (() => void) | null = null
  close() {}
}

/** EventSource the test drives by hand: emit named events, fail the connection. */
class FakeEventSource extends EventTarget {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSED = 2
  static instances: FakeEventSource[] = []
  readyState = 0
  onerror: (() => void) | null = null
  constructor() {
    super()
    FakeEventSource.instances.push(this)
  }
  close() {
    this.readyState = FakeEventSource.CLOSED
  }
  emit(type: string) {
    this.dispatchEvent(new MessageEvent(type, { data: '{}' }))
  }
  fail(readyState: number) {
    this.readyState = readyState
    this.onerror?.()
  }
}
const lastSource = () => FakeEventSource.instances.at(-1)!

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  FakeEventSource.instances = []
})

it('redirects anonymous users to /login and keeps the target', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => json({ error: 'unauthorized' }, 401)))
  const { router } = setup('/settings?group=proxy')
  await waitFor(() => expect(router.state.location.pathname).toBe('/login'))
  expect(router.state.location.search).toEqual({ redirect: '/settings?group=proxy' })
  expect(await screen.findByRole('button', { name: 'Войти' })).toBeInTheDocument()
  await waitFor(() => expect(document.title).toBe('Вход | 159.team'))
})

it('renders the shell with the active tab for signed-in admins', async () => {
  vi.stubGlobal('EventSource', SilentEventSource)
  vi.stubGlobal('fetch', vi.fn(async (url: string) => (signedIn(url))))
  setup('/')
  expect(await screen.findByRole('heading', { name: 'Коды' })).toBeInTheDocument()
  expect(screen.getAllByRole('tab', { name: 'Коды' })[0]).toHaveAttribute('aria-selected', 'true')
  await waitFor(() => expect(document.title).toBe('Коды | 159.team'))
})

it('returns to /login when the session is revoked while browsing', async () => {
  vi.stubGlobal('EventSource', SilentEventSource)
  let revoked = false
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (revoked) return json({ error: 'unauthorized' }, 401)
      return signedIn(url)
    }),
  )
  const { router, queryClient } = setup('/')
  expect(await screen.findByRole('heading', { name: 'Коды' })).toBeInTheDocument()
  revoked = true
  await queryClient.invalidateQueries({ queryKey: ['settings'] })
  await waitFor(() => expect(router.state.location.pathname).toBe('/login'))
})

/** Signed-in shell on `/` with a fake EventSource; flip `state.revoked` to make every request 401. */
async function signedInWithStream() {
  vi.stubGlobal('EventSource', FakeEventSource)
  const state = { revoked: false }
  const fetchMock = vi.fn(async (url: string) => {
    if (state.revoked) return json({ error: 'unauthorized' }, 401)
    return signedIn(url)
  })
  vi.stubGlobal('fetch', fetchMock)
  const { router } = setup('/')
  expect(await screen.findByRole('heading', { name: 'Коды' })).toBeInTheDocument()
  lastSource().emit('ready')
  return { router, state, fetchMock }
}

it('returns to /login when the event stream reports the session as gone', async () => {
  const { router, state } = await signedInWithStream()
  state.revoked = true
  lastSource().emit('unauthorized')
  await waitFor(() => expect(router.state.location.pathname).toBe('/login'))
})

it('returns to /login when the event stream fails and the session is no longer valid', async () => {
  const { router, state } = await signedInWithStream()
  state.revoked = true
  // the browser gave up reconnecting (a reconnect got 401)
  lastSource().fail(FakeEventSource.CLOSED)
  await waitFor(() => expect(router.state.location.pathname).toBe('/login'))
})

it('stays signed in when the stream drops but the session is still valid', async () => {
  const { router, fetchMock } = await signedInWithStream()
  lastSource().fail(FakeEventSource.CONNECTING)
  await waitFor(() => expect(fetchMock.mock.calls.filter(([url]) => url.endsWith('/auth/me')).length).toBeGreaterThan(1))
  expect(router.state.location.pathname).toBe('/')
})

it('refetches data after the stream reconnects (events may have been missed)', async () => {
  const { fetchMock } = await signedInWithStream()
  const settingsCalls = () => fetchMock.mock.calls.filter(([url]) => url.endsWith('/settings')).length
  await waitFor(() => expect(settingsCalls()).toBe(1))
  lastSource().emit('ready') // a repeated ready without a drop is not a reconnect
  lastSource().fail(FakeEventSource.CONNECTING)
  lastSource().emit('ready')
  await waitFor(() => expect(settingsCalls()).toBe(2))
})

it('shows an error screen with a retry instead of a blank page when the API is down', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {}) // the router logs the caught 502
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  let up = false
  vi.stubGlobal('EventSource', SilentEventSource)
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (!up) return json({ error: 'internal' }, 502)
    return signedIn(url)
  }))
  setup('/')
  expect(await screen.findByText('Не удалось загрузить страницу')).toBeInTheDocument()
  up = true
  screen.getByRole('button', { name: 'Повторить' }).click()
  expect(await screen.findByRole('heading', { name: 'Коды' })).toBeInTheDocument()
})

it('shows «not found» for an unknown address', async () => {
  vi.stubGlobal('EventSource', SilentEventSource)
  vi.stubGlobal('fetch', vi.fn(async (url: string) => (signedIn(url))))
  setup('/no-such-page')
  expect(await screen.findByText('Страница не найдена')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'На главную' })).toHaveAttribute('href', '/')
})
