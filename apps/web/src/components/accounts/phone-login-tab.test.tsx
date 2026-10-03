import { act, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { AppEvent } from '@workspace/shared/events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { emitAppEvent } from '@/lib/app-events'
import { proxyFixture } from '@/test/fixtures'
import { json, renderWithClient } from '@/test/render'
import { PhoneLoginTab } from './phone-login-tab'

const navigate = vi.fn()
vi.mock('@tanstack/react-router', async (importOriginal) => ({ ...(await importOriginal<object>()), useNavigate: () => navigate }))

const LOGIN_ID = '00000000-0000-4000-8000-0000000000e1'
const phone = (patch: Omit<Extract<AppEvent, { type: 'phone.update' }>, 'type' | 'loginId'>, loginId = LOGIN_ID) =>
  act(() => emitAppEvent({ type: 'phone.update', loginId, ...patch }))
const codeSent = { state: 'code_sent' as const, deliveryType: 'app', codeLength: 5, nextType: 'sms', retryAfterSec: 60 }

let fetchMock: ReturnType<typeof vi.fn>
beforeEach(() => {
  navigate.mockReset()
  fetchMock = vi.fn(async (url: string) => {
    if (url === '/api/proxies') return json({ items: [proxyFixture()] })
    if (url === '/api/phone-login') return json({ loginId: LOGIN_ID }, 201)
    return new Response(null, { status: 202 })
  })
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => vi.unstubAllGlobals())

const bodyOf = (path: string) => {
  const calls = fetchMock.mock.calls.filter(([url]) => url === path) as [string, RequestInit][]
  return calls.map(([, init]) => (init.body ? JSON.parse(String(init.body)) : null))
}

async function startLogin(user: ReturnType<typeof userEvent.setup>) {
  await waitFor(() => expect(screen.getByLabelText('Подключение')).toHaveTextContent('194.53.188.10:50101'))
  await user.type(screen.getByLabelText('Номер телефона'), '+7 700 123 45 67')
  await user.click(screen.getByRole('button', { name: 'Получить код' }))
  await waitFor(() => expect(bodyOf('/api/phone-login')).toEqual([{ phone: '+7 700 123 45 67', proxyId: proxyFixture().id }]))
}

describe('PhoneLoginTab', () => {
  it('goes through the code (wrong first), the cloud password (wrong first) and opens the new account', async () => {
    const onDone = vi.fn()
    const user = userEvent.setup()
    renderWithClient(<PhoneLoginTab onDone={onDone} />)
    await startLogin(user)

    await phone(codeSent)
    expect(await screen.findByText('Код отправлен в приложение Telegram — сообщением от «Telegram»')).toBeInTheDocument()
    expect(screen.getByText('Код из 5 цифр')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Отправить по SMS/ })).toBeDisabled()

    await user.type(screen.getByLabelText('Код'), '11111')
    await user.click(screen.getByRole('button', { name: 'Войти' }))
    await waitFor(() => expect(bodyOf(`/api/phone-login/${LOGIN_ID}/code`)).toEqual([{ code: '11111' }]))
    await phone({ ...codeSent, state: 'code_invalid' })
    expect(screen.getByText('Неверный код')).toBeInTheDocument()
    expect((screen.getByLabelText('Код') as HTMLInputElement).value).toBe('')

    await phone({ state: 'password_needed', hint: 'кот' })
    expect(screen.getByText('Подсказка: кот')).toBeInTheDocument()
    await user.type(screen.getByLabelText('Облачный пароль'), 'wrong')
    await user.click(screen.getByRole('button', { name: 'Войти' }))
    await waitFor(() => expect(bodyOf(`/api/phone-login/${LOGIN_ID}/password`)).toEqual([{ password: 'wrong' }]))
    await phone({ state: 'password_invalid', hint: 'кот' })
    expect(screen.getByText('Неверный пароль — попробуйте ещё раз')).toBeInTheDocument()

    await phone({ state: 'done', accountId: '00000000-0000-4000-8000-0000000000a1' })
    expect(onDone).toHaveBeenCalled()
    expect(navigate).toHaveBeenCalledWith({ to: '/accounts/$id', params: { id: '00000000-0000-4000-8000-0000000000a1' } })
  })

  it('lets the code be sent again once Telegram allows it, by the next method', async () => {
    const user = userEvent.setup()
    renderWithClient(<PhoneLoginTab onDone={vi.fn()} />)
    await startLogin(user)
    await phone({ ...codeSent, retryAfterSec: 0 })
    await user.click(await screen.findByRole('button', { name: 'Отправить по SMS' }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(`/api/phone-login/${LOGIN_ID}/resend`, expect.objectContaining({ method: 'POST' })))
    await phone({ ...codeSent, deliveryType: 'sms', nextType: 'none', state: 'code_expired' })
    expect(screen.getByText('Код истёк — запросите новый')).toBeInTheDocument()
    expect(screen.getByText('Код отправлен по SMS')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Отправить/ })).not.toBeInTheDocument()
  })

  it('after an expired code offers a fresh one even when Telegram has no next method, and says why a resend did not happen', async () => {
    const user = userEvent.setup()
    renderWithClient(<PhoneLoginTab onDone={vi.fn()} />)
    await startLogin(user)
    await phone({ ...codeSent, nextType: 'none', retryAfterSec: 0 })
    expect(await screen.findByLabelText('Код')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Отправить|Запросить/ })).not.toBeInTheDocument()

    await phone({ ...codeSent, nextType: 'none', state: 'code_expired' })
    await user.click(screen.getByRole('button', { name: 'Запросить новый код' }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(`/api/phone-login/${LOGIN_ID}/resend`, expect.objectContaining({ method: 'POST' })))
    // waiting for Telegram: no second request from a double click
    expect(screen.getByRole('button', { name: 'Запросить новый код' })).toBeDisabled()

    await phone({ ...codeSent, message: 'Telegram не отправил код повторно — введите код, который уже пришёл' })
    expect(screen.getByText('Telegram не отправил код повторно — введите код, который уже пришёл')).toBeInTheDocument()
  })

  it('shows what went wrong on every step: a mistyped number, a refused code, a failed password', async () => {
    let startCalls = 0
    fetchMock.mockImplementation(async (url: string) => {
      if (url === '/api/proxies') return json({ items: [proxyFixture()] })
      if (url === '/api/phone-login') {
        startCalls++
        return startCalls === 1
          ? json({ error: 'validation', fields: { phone: 'Номер — от 7 до 15 цифр, например +7 700 123 45 67' } }, 400)
          : json({ loginId: LOGIN_ID }, 201)
      }
      if (url.endsWith('/code')) return json({ error: 'validation', fields: { code: 'Код — только цифры' } }, 400)
      if (url.endsWith('/password')) return json({ error: 'telegram_error', message: 'Воркер не отвечает' }, 503)
      return new Response(null, { status: 202 })
    })
    const user = userEvent.setup()
    renderWithClient(<PhoneLoginTab onDone={vi.fn()} />)
    await waitFor(() => expect(screen.getByLabelText('Подключение')).toHaveTextContent('194.53.188.10'))
    await user.type(screen.getByLabelText('Номер телефона'), '12')
    await user.click(screen.getByRole('button', { name: 'Получить код' }))
    expect(await screen.findByText('Номер — от 7 до 15 цифр, например +7 700 123 45 67')).toBeInTheDocument()
    expect(screen.queryByText('HTTP 400')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Получить код' }))
    await phone(codeSent)
    await user.type(await screen.findByLabelText('Код'), 'abc12')
    await user.click(screen.getByRole('button', { name: 'Войти' }))
    expect(await screen.findByText('Код — только цифры')).toBeInTheDocument()

    await phone({ state: 'password_needed' })
    await user.type(screen.getByLabelText('Облачный пароль'), 'pw')
    await user.click(screen.getByRole('button', { name: 'Войти' }))
    expect(await screen.findByText('Воркер не отвечает')).toBeInTheDocument()
  })

  it('keeps an event that arrives before POST /phone-login answers', async () => {
    let answer!: () => void
    fetchMock.mockImplementation(async (url: string) => {
      if (url === '/api/proxies') return json({ items: [proxyFixture()] })
      if (url === '/api/phone-login') {
        await new Promise<void>((resolve) => (answer = resolve))
        return json({ loginId: LOGIN_ID }, 201)
      }
      return new Response(null, { status: 202 })
    })
    const user = userEvent.setup()
    renderWithClient(<PhoneLoginTab onDone={vi.fn()} />)
    await waitFor(() => expect(screen.getByLabelText('Подключение')).toHaveTextContent('194.53.188.10'))
    await user.type(screen.getByLabelText('Номер телефона'), '77001234567')
    await user.click(screen.getByRole('button', { name: 'Получить код' }))
    await waitFor(() => expect(answer).toBeTypeOf('function'))
    await phone(codeSent)
    await act(async () => answer())
    expect(await screen.findByLabelText('Код')).toBeInTheDocument()
  })

  it('shows why the login failed and starts over', async () => {
    const user = userEvent.setup()
    renderWithClient(<PhoneLoginTab onDone={vi.fn()} />)
    await startLogin(user)
    await phone({ state: 'failed', message: 'Номер заблокирован Telegram' })
    expect(await screen.findByText('Не удалось войти')).toBeInTheDocument()
    expect(screen.getByText('Номер заблокирован Telegram')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Начать заново' }))
    expect(screen.getByRole('button', { name: 'Получить код' })).toBeInTheDocument()
  })

  it('cancels a running login on the worker when closed', async () => {
    const user = userEvent.setup()
    const { unmount } = renderWithClient(<PhoneLoginTab onDone={vi.fn()} />)
    await startLogin(user)
    await phone(codeSent)
    await screen.findByLabelText('Код')
    unmount()
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(`/api/phone-login/${LOGIN_ID}`, expect.objectContaining({ method: 'DELETE' })))
  })
})
