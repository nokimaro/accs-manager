import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { AccountSessionDto } from '@workspace/shared/accounts'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { accountFixture, proxyFixture } from '@/test/fixtures'
import { json, renderWithClient } from '@/test/render'
import { AccountRouteForm } from './account-route-form'
import { AccountSessions } from './account-sessions'
import { DeleteAccountDialog } from './delete-account-dialog'

const navigate = vi.fn()
vi.mock('@tanstack/react-router', async (importOriginal) => ({ ...(await importOriginal<object>()), useNavigate: () => navigate }))

const account = accountFixture()
let fetchMock: ReturnType<typeof vi.fn>
const calls = (method: string) => fetchMock.mock.calls.filter(([, init]) => ((init as RequestInit | undefined)?.method ?? 'GET') === method).map(([url, init]) => ({ url: String(url), init: init as RequestInit }))

beforeEach(() => navigate.mockReset())
afterEach(() => vi.unstubAllGlobals())

describe('AccountRouteForm', () => {
  it('an account waiting for a proxy gets one chosen from the free ones', async () => {
    const free = proxyFixture()
    const busy = proxyFixture({ id: '00000000-0000-4000-8000-000000000002', host: '194.53.188.11', account: { id: 'x', label: 'другой', phone: null, username: null } })
    fetchMock = vi.fn(async (_url: string, init?: RequestInit) =>
      init?.method === 'PUT' ? json({ ...account, proxy: { ...free, status: 'ok' } }) : json({ items: [free, busy] }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const user = userEvent.setup()
    renderWithClient(<AccountRouteForm account={account} />)

    expect(screen.getByLabelText('Прокси')).toHaveTextContent('Выберите прокси')
    expect(screen.getByRole('button', { name: 'Сохранить и переподключить' })).toBeDisabled()

    await user.click(screen.getByLabelText('Прокси'))
    expect(await screen.findByRole('option', { name: /194\.53\.188\.10:50101/ })).toBeInTheDocument()
    expect(screen.queryByRole('option', { name: /194\.53\.188\.11/ })).not.toBeInTheDocument()
    await user.click(screen.getByRole('option', { name: /194\.53\.188\.10:50101/ }))
    await user.click(screen.getByRole('button', { name: 'Сохранить и переподключить' }))

    await waitFor(() => expect(calls('PUT')).toHaveLength(1))
    expect(calls('PUT')[0]!.url).toBe(`/api/accounts/${account.id}/proxy`)
    expect(JSON.parse(String(calls('PUT')[0]!.init.body))).toEqual({ proxyId: free.id })
  })

  it('«напрямую» sends proxyId null', async () => {
    fetchMock = vi.fn(async (_url: string, init?: RequestInit) => (init?.method === 'PUT' ? json({ ...account, connectionMode: 'direct' }) : json({ items: [] })))
    vi.stubGlobal('fetch', fetchMock)
    const user = userEvent.setup()
    renderWithClient(<AccountRouteForm account={account} />)
    await user.click(screen.getByLabelText('Прокси'))
    await user.click(await screen.findByRole('option', { name: 'Напрямую, без прокси' }))
    await user.click(screen.getByRole('button', { name: 'Сохранить и переподключить' }))
    await waitFor(() => expect(calls('PUT')).toHaveLength(1))
    expect(JSON.parse(String(calls('PUT')[0]!.init.body))).toEqual({ proxyId: null })
  })
})

describe('DeleteAccountDialog', () => {
  it('deletes with «завершить сессию» and goes back to the list', async () => {
    fetchMock = vi.fn(async () => new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetchMock)
    const user = userEvent.setup()
    renderWithClient(<DeleteAccountDialog account={account} />)

    await user.click(screen.getByRole('button', { name: 'Удалить' }))
    await user.click(screen.getByRole('checkbox', { name: 'Завершить сессию в Telegram' }))
    await user.click(screen.getAllByRole('button', { name: 'Удалить' }).at(-1)!)

    await waitFor(() => expect(navigate).toHaveBeenCalledWith({ to: '/accounts' }))
    expect(calls('DELETE')[0]!.url).toBe(`/api/accounts/${account.id}?logout=true`)
  })

  it('keeps the dialog open with the reason when Telegram logout failed', async () => {
    fetchMock = vi.fn(async () => json({ error: 'logout_failed', message: 'Не удалось завершить сессию в Telegram (аккаунт не подключён?) — удалите без выхода' }, 409))
    vi.stubGlobal('fetch', fetchMock)
    const user = userEvent.setup()
    renderWithClient(<DeleteAccountDialog account={account} />)
    await user.click(screen.getByRole('button', { name: 'Удалить' }))
    await user.click(screen.getByRole('checkbox', { name: 'Завершить сессию в Telegram' }))
    await user.click(screen.getAllByRole('button', { name: 'Удалить' }).at(-1)!)

    expect(await screen.findByText(/удалите без выхода/)).toBeInTheDocument()
    expect(navigate).not.toHaveBeenCalled()
  })
})

describe('AccountSessions', () => {
  const session = (over: Partial<AccountSessionDto>): AccountSessionDto => ({
    hash: '0',
    current: false,
    official: true,
    appName: 'Telegram Android',
    appVersion: '12.0',
    deviceModel: 'Pixel 8',
    platform: 'Android',
    systemVersion: '15',
    ip: '5.34.1.1',
    country: 'Kazakhstan',
    region: '',
    createdAt: '2026-09-01T00:00:00.000Z',
    activeAt: '2026-10-03T00:00:00.000Z',
    ...over,
  })

  it('asks Telegram only on demand and terminates another device', async () => {
    fetchMock = vi.fn(async (_url: string, init?: RequestInit) =>
      init?.method === 'DELETE'
        ? new Response(null, { status: 204 })
        : json({ items: [session({ hash: '0', current: true, appName: 'Telegram Desktop', appVersion: '7.2.9 x64' }), session({ hash: '-123456789' })] }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const user = userEvent.setup()
    renderWithClient(<AccountSessions accountId={account.id} running />)
    expect(fetchMock).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: 'Показать активные сессии' }))
    expect(await screen.findByText('Telegram Android 12.0')).toBeInTheDocument()
    expect(screen.getByText('панель')).toBeInTheDocument()
    // the panel's own session cannot be terminated from here
    expect(screen.getAllByRole('button', { name: 'Завершить' })).toHaveLength(1)

    await user.click(screen.getByRole('button', { name: 'Завершить' }))
    await user.click(screen.getAllByRole('button', { name: 'Завершить' }).at(-1)!)
    await waitFor(() => expect(calls('DELETE')).toHaveLength(1))
    expect(calls('DELETE')[0]!.url).toBe(`/api/accounts/${account.id}/sessions/-123456789`)
  })

  it('is unavailable while the account is not connected', () => {
    vi.stubGlobal('fetch', vi.fn())
    renderWithClient(<AccountSessions accountId={account.id} running={false} />)
    expect(screen.getByRole('button', { name: 'Показать активные сессии' })).toBeDisabled()
  })
})
