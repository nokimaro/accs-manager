import { QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, RouterProvider } from '@tanstack/react-router'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createQueryClient } from '@/lib/query-client'
import { createAppRouter } from '@/lib/router'
import { accountFixture, proxyFixture } from '@/test/fixtures'
import { json } from '@/test/render'

class FakeEventSource extends EventTarget {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSED = 2
  readyState = 1
  onerror: (() => void) | null = null
  close() {}
}

const shared = proxyFixture({
  host: '194.53.188.10',
  accounts: [
    { id: '00000000-0000-4000-8000-0000000000a1', label: 'Первый', phone: null, username: null },
    { id: '00000000-0000-4000-8000-0000000000a2', label: null, phone: '77007654321', username: null },
  ],
})
const single = proxyFixture({ id: '00000000-0000-4000-8000-000000000002', host: '194.53.188.11', accounts: [{ id: '00000000-0000-4000-8000-0000000000a3', label: 'Третий', phone: null, username: null }] })
const account = accountFixture({ id: '00000000-0000-4000-8000-0000000000a1', label: 'Первый', proxy: { id: shared.id, type: 'socks5', host: shared.host, port: shared.port, status: 'ok', tgCountry: 'KZ' } })
const free = proxyFixture({ id: '00000000-0000-4000-8000-000000000003', host: '194.53.188.12' })

afterEach(() => vi.unstubAllGlobals())

function setup(path = '/proxies') {
  vi.stubGlobal('EventSource', FakeEventSource)
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const u = new URL(url, 'http://panel.test')
      if (u.pathname === '/api/auth/me') return json({ id: 'a1', login: 'root' })
      if (u.pathname === '/api/settings') return json({ items: {} })
      if (u.pathname === '/api/proxies') return json({ items: [shared, single, free] })
      if (u.pathname === '/api/proxies/sync-status') return json({ status: null })
      if (u.pathname === `/api/accounts/${account.id}`) return json(account)
      return json({ items: [] })
    }),
  )
  const queryClient = createQueryClient()
  const router = createAppRouter(queryClient, createMemoryHistory({ initialEntries: [path] }))
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
}

const row = (host: string) => screen.getByText(new RegExp(`${host.replaceAll('.', '\\.')}:50101`)).closest('tr')!

describe('proxies page', () => {
  it('shows every account of a shared proxy, marks it and filters shared ones', async () => {
    setup()
    expect(await screen.findByRole('link', { name: 'Первый' })).toHaveAttribute('href', '/accounts/00000000-0000-4000-8000-0000000000a1')
    const sharedRow = row('194.53.188.10')
    expect(within(sharedRow).getByRole('link', { name: '+77007654321' })).toBeInTheDocument()
    expect(within(sharedRow).getByText('×2')).toBeInTheDocument()
    expect(within(row('194.53.188.11')).queryByText(/^×/)).not.toBeInTheDocument()
    expect(within(row('194.53.188.12')).getByText('свободен')).toBeInTheDocument()

    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Общие' }))
    expect(screen.getByText(/194\.53\.188\.10:50101/)).toBeInTheDocument()
    expect(screen.queryByText(/194\.53\.188\.11:50101/)).not.toBeInTheDocument()
    expect(screen.queryByText(/194\.53\.188\.12:50101/)).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Свободные' }))
    expect(screen.getByText(/194\.53\.188\.12:50101/)).toBeInTheDocument()
    expect(screen.queryByText(/194\.53\.188\.10:50101/)).not.toBeInTheDocument()
  })

  it('the account card names the other accounts on its proxy', async () => {
    setup(`/accounts/${account.id}`)
    expect(await screen.findByText('Также на этом прокси:')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: '+77007654321' })).toHaveAttribute('href', '/accounts/00000000-0000-4000-8000-0000000000a2')
  })
})
