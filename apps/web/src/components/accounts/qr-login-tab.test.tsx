import { act, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { AppEvent } from '@workspace/shared/events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { emitAppEvent } from '@/lib/app-events'
import { proxyFixture } from '@/test/fixtures'
import { json, renderWithClient } from '@/test/render'
import { QrLoginTab } from './qr-login-tab'

const navigate = vi.fn()
vi.mock('@tanstack/react-router', async (importOriginal) => ({ ...(await importOriginal<object>()), useNavigate: () => navigate }))
// jsdom has no canvas: the QR image itself is the library's business
vi.mock('qrcode', () => ({ default: { toDataURL: vi.fn(async (url: string) => `data:image/png;base64,${btoa(url)}`) } }))

const QR_ID = '00000000-0000-4000-8000-0000000000d1'
const qr = (patch: Omit<Extract<AppEvent, { type: 'qr.update' }>, 'type' | 'qrId'>, qrId = QR_ID) =>
  act(() => emitAppEvent({ type: 'qr.update', qrId, ...patch }))

let fetchMock: ReturnType<typeof vi.fn>
beforeEach(() => {
  navigate.mockReset()
  fetchMock = vi.fn(async (url: string) => {
    if (url === '/api/proxies') return json({ items: [proxyFixture()] })
    if (url === '/api/qr') return json({ qrId: QR_ID }, 201)
    return new Response(null, { status: 202 })
  })
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => vi.unstubAllGlobals())

const bodyOf = (path: string) => {
  const call = fetchMock.mock.calls.find(([url]) => url === path) as [string, RequestInit] | undefined
  return call && JSON.parse(String(call[1].body))
}

describe('QrLoginTab', () => {
  it('goes through QR → scanned → 2FA → done and opens the new account', async () => {
    const onDone = vi.fn()
    const user = userEvent.setup()
    renderWithClient(<QrLoginTab onDone={onDone} />)

    await waitFor(() => expect(screen.getByLabelText('Подключение')).toHaveTextContent('194.53.188.10:50101'))
    await user.click(screen.getByRole('button', { name: 'Показать QR-код' }))
    await waitFor(() => expect(bodyOf('/api/qr')).toEqual({ proxyId: proxyFixture().id }))

    await qr({ state: 'waiting', url: 'tg://login?token=abc' })
    expect(await screen.findByAltText('QR-код для входа в Telegram')).toHaveAttribute('src', `data:image/png;base64,${btoa('tg://login?token=abc')}`)

    await qr({ state: 'scanned' })
    expect(screen.getByText('QR отсканирован — подтвердите вход в Telegram')).toBeInTheDocument()

    await qr({ state: 'password_needed', hint: 'кот' })
    expect(screen.getByText('Подсказка: кот')).toBeInTheDocument()
    await user.type(screen.getByLabelText('Пароль двухэтапной проверки'), 'secret-2fa')
    await user.click(screen.getByRole('button', { name: 'Войти' }))
    await waitFor(() => expect(bodyOf(`/api/qr/${QR_ID}/password`)).toEqual({ password: 'secret-2fa' }))

    await qr({ state: 'password_invalid', hint: 'кот' })
    expect(screen.getByText('Неверный пароль — попробуйте ещё раз')).toBeInTheDocument()
    // the typed password is not kept after it was sent
    expect((screen.getByLabelText('Пароль двухэтапной проверки') as HTMLInputElement).value).toBe('')

    await qr({ state: 'done', accountId: '00000000-0000-4000-8000-0000000000a1' })
    expect(onDone).toHaveBeenCalled()
    expect(navigate).toHaveBeenCalledWith({ to: '/accounts/$id', params: { id: '00000000-0000-4000-8000-0000000000a1' } })
  })

  it('ignores events of other logins and keeps one that arrives before POST /qr answers', async () => {
    let answer!: () => void
    fetchMock.mockImplementation(async (url: string) => {
      if (url === '/api/proxies') return json({ items: [proxyFixture()] })
      if (url === '/api/qr') {
        await new Promise<void>((resolve) => (answer = resolve))
        return json({ qrId: QR_ID }, 201)
      }
      return new Response(null, { status: 202 })
    })
    const user = userEvent.setup()
    renderWithClient(<QrLoginTab onDone={vi.fn()} />)
    await waitFor(() => expect(screen.getByLabelText('Подключение')).toHaveTextContent('194.53.188.10'))
    await user.click(screen.getByRole('button', { name: 'Показать QR-код' }))
    await waitFor(() => expect(answer).toBeTypeOf('function'))

    await qr({ state: 'waiting', url: 'tg://login?token=early' })
    await act(async () => answer())
    expect(await screen.findByAltText('QR-код для входа в Telegram')).toHaveAttribute('src', `data:image/png;base64,${btoa('tg://login?token=early')}`)

    await qr({ state: 'failed', message: 'чужой вход' }, '00000000-0000-4000-8000-0000000000ff')
    expect(screen.queryByText('Не удалось войти')).not.toBeInTheDocument()
  })

  it('shows why the login failed and starts over', async () => {
    const user = userEvent.setup()
    renderWithClient(<QrLoginTab onDone={vi.fn()} />)
    await waitFor(() => expect(screen.getByLabelText('Подключение')).toHaveTextContent('194.53.188.10'))
    await user.click(screen.getByRole('button', { name: 'Показать QR-код' }))
    await waitFor(() => expect(bodyOf('/api/qr')).toBeDefined())
    await qr({ state: 'failed', message: 'Этот аккаунт уже есть в панели' })

    expect(await screen.findByText('Не удалось войти')).toBeInTheDocument()
    expect(screen.getByText('Этот аккаунт уже есть в панели')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Начать заново' }))
    expect(screen.getByRole('button', { name: 'Показать QR-код' })).toBeInTheDocument()
  })

  it('cancels a running login on the worker when closed', async () => {
    const user = userEvent.setup()
    const { unmount } = renderWithClient(<QrLoginTab onDone={vi.fn()} />)
    await waitFor(() => expect(screen.getByLabelText('Подключение')).toHaveTextContent('194.53.188.10'))
    await user.click(screen.getByRole('button', { name: 'Показать QR-код' }))
    await qr({ state: 'waiting', url: 'tg://login?token=abc' })
    await screen.findByAltText('QR-код для входа в Telegram')

    unmount()
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(`/api/qr/${QR_ID}`, expect.objectContaining({ method: 'DELETE' })))
  })

  it('without free proxies waits for an explicit choice instead of going direct', async () => {
    fetchMock.mockImplementation(async (url: string) => (url === '/api/proxies' ? json({ items: [] }) : json({ qrId: QR_ID }, 201)))
    renderWithClient(<QrLoginTab onDone={vi.fn()} />)
    await waitFor(() => expect(screen.getByLabelText('Подключение')).toHaveTextContent('Свободных прокси нет — выберите вариант'))
    expect(screen.getByRole('button', { name: 'Показать QR-код' })).toBeDisabled()
  })
})
