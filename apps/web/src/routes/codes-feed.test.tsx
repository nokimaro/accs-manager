import { QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, RouterProvider } from '@tanstack/react-router'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { CodeDto } from '@workspace/shared/accounts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createQueryClient } from '@/lib/query-client'
import { createAppRouter } from '@/lib/router'
import { accountFixture } from '@/test/fixtures'
import { json } from '@/test/render'

/** EventSource the test drives by hand. */
class FakeEventSource extends EventTarget {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSED = 2
  static last: FakeEventSource | null = null
  readyState = 1
  onerror: (() => void) | null = null
  constructor() {
    super()
    FakeEventSource.last = this
  }
  close() {}
  emit(type: string, data: unknown = {}) {
    this.dispatchEvent(new MessageEvent(type, { data: JSON.stringify(data) }))
  }
}

const A1 = accountFixture()
const A2 = accountFixture({ id: '00000000-0000-4000-8000-0000000000a2', tgUserId: 7_000_002, phone: '77007654321', label: 'Второй' })

const code = (id: number, over: Partial<CodeDto> = {}): CodeDto => ({
  id,
  accountId: A1.id,
  account: { label: null, phone: A1.phone, username: null },
  tgMessageId: id,
  date: new Date(Date.now() - (1000 - id) * 60_000).toISOString(),
  text: `Your code: ${100000 + id}`,
  code: String(100000 + id),
  notifiedAt: null,
  ...over,
})

afterEach(() => vi.unstubAllGlobals())

function setup(path: string, codes: (params: URLSearchParams) => CodeDto[]) {
  vi.stubGlobal('EventSource', FakeEventSource)
  const fetchMock = vi.fn(async (url: string) => {
    const u = new URL(url, 'http://panel.test')
    if (u.pathname === '/api/auth/me') return json({ id: 'a1', login: 'root' })
    if (u.pathname === '/api/settings') return json({ items: {} })
    if (u.pathname === '/api/accounts') return json({ items: [A1, A2] })
    if (u.pathname === '/api/codes') return json({ items: codes(u.searchParams) })
    return json({ items: [] })
  })
  vi.stubGlobal('fetch', fetchMock)
  const queryClient = createQueryClient()
  const router = createAppRouter(queryClient, createMemoryHistory({ initialEntries: [path] }))
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
  return { router, fetchMock }
}

const codesCalls = (fetchMock: ReturnType<typeof vi.fn>) =>
  fetchMock.mock.calls.map(([url]) => new URL(String(url), 'http://panel.test')).filter((u) => u.pathname === '/api/codes')

describe('codes feed', () => {
  it('shows codes of all accounts with a copy button and pages back with «Показать ещё»', async () => {
    // 50 on the first page (a full page), 1 older on the second
    const { fetchMock } = setup('/', (p) => (p.get('before') ? [code(1)] : Array.from({ length: 50 }, (_, i) => code(100 - i))))
    expect(await screen.findByRole('button', { name: 'Скопировать код 100100' })).toBeInTheDocument()
    expect(screen.getAllByRole('link', { name: '+77001234567' }).length).toBeGreaterThan(0)

    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Показать ещё' }))
    expect(await screen.findByRole('button', { name: 'Скопировать код 100001' })).toBeInTheDocument()
    expect(codesCalls(fetchMock).at(-1)!.searchParams.get('before')).toBe('51')
    // a short page is the last one
    expect(screen.queryByRole('button', { name: 'Показать ещё' })).not.toBeInTheDocument()
  })

  it('filters by account through the URL', async () => {
    const { fetchMock, router } = setup(`/?account=${A2.id}`, () => [code(5, { accountId: A2.id, account: { label: 'Второй', phone: A2.phone, username: null } })])
    expect(await screen.findByRole('button', { name: 'Скопировать код 100005' })).toBeInTheDocument()
    expect(codesCalls(fetchMock).at(-1)!.searchParams.get('accountId')).toBe(A2.id)
    expect(screen.getByLabelText('Аккаунт')).toHaveTextContent('Второй')
    expect(router.state.location.search).toEqual({ account: A2.id })
  })

  it('a new code arrives live and is marked', async () => {
    let list = [code(10)]
    setup('/', () => list)
    expect(await screen.findByRole('button', { name: 'Скопировать код 100010' })).toBeInTheDocument()
    act(() => FakeEventSource.last!.emit('ready'))

    list = [code(11), code(10)]
    act(() => FakeEventSource.last!.emit('code.new', { type: 'code.new', id: 11, accountId: A1.id, code: '100011', date: new Date().toISOString() }))
    const row = (await screen.findByRole('button', { name: 'Скопировать код 100011' })).closest('tr')!
    expect(within(row).getByText('новый')).toBeInTheDocument()
    await waitFor(() => expect(screen.getAllByText('новый')).toHaveLength(1))
  })

  it('does not mark history caught up after a reconnect as new', async () => {
    let list = [code(30)]
    setup('/', () => list)
    expect(await screen.findByRole('button', { name: 'Скопировать код 100030' })).toBeInTheDocument()
    act(() => FakeEventSource.last!.emit('ready'))

    const old = code(31, { date: new Date(Date.now() - 3 * 86_400_000).toISOString() })
    list = [code(30), old]
    act(() => FakeEventSource.last!.emit('code.new', { type: 'code.new', id: 31, accountId: A1.id, code: '100031', date: old.date }))
    expect(await screen.findByRole('button', { name: 'Скопировать код 100031' })).toBeInTheDocument()
    expect(screen.queryByText('новый')).not.toBeInTheDocument()
  })

  it('copies a code to the clipboard', async () => {
    setup('/', () => [code(7)])
    const user = userEvent.setup()
    const writeText = vi.spyOn(navigator.clipboard, 'writeText')
    await user.click(await screen.findByRole('button', { name: 'Скопировать код 100007' }))
    expect(writeText).toHaveBeenCalledWith('100007')
  })
})
