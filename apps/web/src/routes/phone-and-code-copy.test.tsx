import { QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, RouterProvider } from '@tanstack/react-router'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { CodeDto } from '@workspace/shared/accounts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createQueryClient } from '@/lib/query-client'
import { createAppRouter } from '@/lib/router'
import { accountFixture } from '@/test/fixtures'
import { json } from '@/test/render'

class FakeEventSource extends EventTarget {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSED = 2
  readyState = 1
  onerror: (() => void) | null = null
  close() {}
}

const labelled = accountFixture({ label: 'OLIMP-1', phone: '77066843426', lastCode: '437610', lastCodeAt: new Date(Date.now() - 5 * 60_000).toISOString() })
const plain = accountFixture({ id: '00000000-0000-4000-8000-0000000000a2', tgUserId: 7_000_002, phone: '77015550000' })
const code: CodeDto = {
  id: 1,
  accountId: labelled.id,
  account: { label: 'OLIMP-1', phone: '77066843426', username: null },
  tgMessageId: 1,
  date: new Date().toISOString(),
  text: 'Your code is 437610',
  code: '437610',
  notifiedAt: null,
}

afterEach(() => vi.unstubAllGlobals())

function setup(path: string) {
  vi.stubGlobal('EventSource', FakeEventSource)
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const u = new URL(url, 'http://panel.test')
      if (u.pathname === '/api/auth/me') return json({ id: 'a1', login: 'root' })
      if (u.pathname === '/api/settings') return json({ items: {} })
      if (u.pathname === '/api/accounts') return json({ items: [labelled, plain] })
      if (u.pathname === '/api/codes') return json({ items: [code] })
      return json({ items: [] })
    }),
  )
  const writeText = vi.fn(async () => {})
  const user = userEvent.setup()
  // after userEvent.setup(): it installs its own clipboard stub
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
  const queryClient = createQueryClient()
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={createAppRouter(queryClient, createMemoryHistory({ initialEntries: [path] }))} />
    </QueryClientProvider>,
  )
  return { user, writeText }
}

describe('phones and codes', () => {
  it('the accounts list keeps the phone under a label, copies it without the plus, and shows the last code to copy', async () => {
    const { user, writeText } = setup('/accounts')
    const row = (await screen.findByRole('link', { name: 'OLIMP-1' })).closest('tr')!
    expect(within(row).getByText('+77066843426')).toBeInTheDocument()
    await user.click(within(row).getByRole('button', { name: 'Скопировать номер +77066843426' }))
    expect(writeText).toHaveBeenLastCalledWith('77066843426')

    await user.click(within(row).getByRole('button', { name: 'Скопировать код 437610' }))
    expect(writeText).toHaveBeenLastCalledWith('437610')
    expect(within(row).getByText('5 минут назад')).toBeInTheDocument()

    // without a label the phone is the title, with the copy button next to it
    const plainRow = screen.getByRole('link', { name: '+77015550000' }).closest('tr')!
    await user.click(within(plainRow).getByRole('button', { name: 'Скопировать номер +77015550000' }))
    expect(writeText).toHaveBeenLastCalledWith('77015550000')
  })

  it('the codes feed shows the phone of a labelled account with a copy button', async () => {
    const { user, writeText } = setup('/')
    const row = (await screen.findByRole('button', { name: 'Скопировать код 437610' })).closest('tr')!
    expect(within(row).getByRole('link', { name: 'OLIMP-1' })).toBeInTheDocument()
    await user.click(within(row).getByRole('button', { name: 'Скопировать номер +77066843426' }))
    expect(writeText).toHaveBeenLastCalledWith('77066843426')
  })
})
