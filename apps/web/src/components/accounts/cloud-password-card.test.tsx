import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { CloudPasswordInfoDto } from '@workspace/shared/accounts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { accountFixture } from '@/test/fixtures'
import { json, renderWithClient } from '@/test/render'
import { CloudPasswordCard } from './cloud-password-card'

const account = accountFixture({ status: 'active' })
const base = `/api/accounts/${account.id}/cloud-password`
const info = (over: Partial<CloudPasswordInfoDto> = {}): CloudPasswordInfoDto => ({
  hasPassword: false,
  hint: null,
  known: false,
  hasRecovery: false,
  recoveryEmail: null,
  unconfirmedEmailPattern: null,
  pendingResetAt: null,
  ...over,
})

afterEach(() => vi.unstubAllGlobals())

/** The api as the test scripts it; `state` is what /info returns now. */
function api(state: { info: CloudPasswordInfoDto }, handlers: Record<string, (body: unknown) => Response> = {}) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${url}`
    const body = init?.body ? JSON.parse(String(init.body)) : null
    if (handlers[key]) return handlers[key](body)
    if (key === `GET ${base}/info`) return json(state.info)
    return new Response(null, { status: 204 })
  })
  vi.stubGlobal('fetch', fetchMock)
  const calls = (key: string) =>
    fetchMock.mock.calls.filter(([url, init]) => `${(init as RequestInit | undefined)?.method ?? 'GET'} ${url}` === key).map(([, init]) => JSON.parse(String((init as RequestInit).body ?? 'null')))
  return { fetchMock, calls }
}

describe('CloudPasswordCard', () => {
  it('shows what Telegram says: a password the panel does not know, the recovery email and a pending reset', async () => {
    api({ info: info({ hasPassword: true, hint: 'кот', hasRecovery: true, pendingResetAt: '2026-10-10T09:00:00.000Z' }) })
    renderWithClient(<CloudPasswordCard account={account} />)
    expect(await screen.findByText('установлен')).toBeInTheDocument()
    expect(screen.getByText('кот')).toBeInTheDocument()
    expect(screen.getByText('неизвестен панели')).toBeInTheDocument()
    expect(screen.getByText('привязана')).toBeInTheDocument()
    expect(screen.getByText(/Запрошен сброс облачного пароля/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Показать' })).not.toBeInTheDocument()
  })

  it('remembers the current password once Telegram accepts it', async () => {
    const state = { info: info({ hasPassword: true }) }
    const { calls } = api(state, {
      [`POST ${base}/verify`]: (body) => {
        if ((body as { password: string }).password !== 'right') return json({ error: 'wrong_password', message: 'Неверный текущий пароль' }, 422)
        state.info = info({ hasPassword: true, known: true, hasRecovery: true, recoveryEmail: 'me@example.com' })
        return new Response(null, { status: 204 })
      },
    })
    const user = userEvent.setup()
    renderWithClient(<CloudPasswordCard account={account} />)
    await user.click(await screen.findByRole('button', { name: 'Указать текущий' }))
    const dialog = screen.getByRole('dialog', { name: 'Текущий облачный пароль' })
    await user.type(within(dialog).getByLabelText('Пароль'), 'wrong')
    await user.click(within(dialog).getByRole('button', { name: 'Проверить' }))
    expect(await within(dialog).findByText('Неверный текущий пароль')).toBeInTheDocument()
    await user.clear(within(dialog).getByLabelText('Пароль'))
    await user.type(within(dialog).getByLabelText('Пароль'), 'right')
    await user.click(within(dialog).getByRole('button', { name: 'Проверить' }))
    expect(await screen.findByText('me@example.com')).toBeInTheDocument()
    expect(calls(`POST ${base}/verify`)).toEqual([{ password: 'wrong' }, { password: 'right' }])
  })

  it('shows the stored password only on request', async () => {
    const { fetchMock } = api({ info: info({ hasPassword: true, known: true }) }, { [`GET ${base}`]: () => json({ password: 'kn0wn-pass' }) })
    const user = userEvent.setup()
    renderWithClient(<CloudPasswordCard account={account} />)
    await user.click(await screen.findByRole('button', { name: 'Показать' }))
    expect(await screen.findByText('kn0wn-pass')).toBeInTheDocument()
    expect(fetchMock).toHaveBeenCalledWith(base, expect.anything())
    await user.click(screen.getByRole('button', { name: 'Скрыть' }))
    expect(screen.queryByText('kn0wn-pass')).not.toBeInTheDocument()
  })

  it('sets a first password, checking the repeat', async () => {
    const state = { info: info() }
    const { calls } = api(state, {
      [`PUT ${base}`]: () => {
        state.info = info({ hasPassword: true, known: true, hint: 'кот' })
        return json({ ok: true })
      },
    })
    const user = userEvent.setup()
    renderWithClient(<CloudPasswordCard account={account} />)
    await user.click(await screen.findByRole('button', { name: 'Установить пароль' }))
    const dialog = screen.getByRole('dialog', { name: 'Новый облачный пароль' })
    expect(within(dialog).queryByLabelText('Текущий пароль')).not.toBeInTheDocument()
    await user.type(within(dialog).getByLabelText('Новый пароль'), 'n3w-pass')
    await user.type(within(dialog).getByLabelText('Повтор пароля'), 'n3w-pas')
    await user.type(within(dialog).getByLabelText('Подсказка'), 'кот')
    await user.click(within(dialog).getByRole('button', { name: 'Сохранить' }))
    expect(within(dialog).getByText('Пароли не совпадают')).toBeInTheDocument()
    expect(calls(`PUT ${base}`)).toEqual([])
    await user.type(within(dialog).getByLabelText('Повтор пароля'), 's')
    await user.click(within(dialog).getByRole('button', { name: 'Сохранить' }))
    await waitFor(() => expect(calls(`PUT ${base}`)).toEqual([{ newPassword: 'n3w-pass', hint: 'кот' }]))
    expect(await screen.findByText('установлен')).toBeInTheDocument()
  })

  it('changes it asking for the current one when the panel does not know it, and shows which one was wrong', async () => {
    const { calls } = api({ info: info({ hasPassword: true }) }, { [`PUT ${base}`]: () => json({ error: 'wrong_password', message: 'Неверный текущий пароль' }, 422) })
    const user = userEvent.setup()
    renderWithClient(<CloudPasswordCard account={account} />)
    await user.click(await screen.findByRole('button', { name: 'Сменить пароль' }))
    const dialog = screen.getByRole('dialog', { name: 'Новый облачный пароль' })
    await user.type(within(dialog).getByLabelText('Текущий пароль'), 'old')
    await user.type(within(dialog).getByLabelText('Новый пароль'), 'n3w')
    await user.type(within(dialog).getByLabelText('Повтор пароля'), 'n3w')
    await user.click(within(dialog).getByRole('button', { name: 'Сохранить' }))
    const current = within(dialog).getByLabelText('Текущий пароль')
    await waitFor(() => expect(current).toHaveAttribute('aria-invalid', 'true'))
    expect(within(dialog).getByText('Неверный текущий пароль')).toBeInTheDocument()
    expect(calls(`PUT ${base}`)).toEqual([{ currentPassword: 'old', newPassword: 'n3w' }])
  })

  it('takes the code from the recovery email, or skips the email', async () => {
    const state = { info: info() }
    const { calls } = api(state, {
      [`PUT ${base}`]: () => json({ emailCodeNeeded: { pattern: 'm***@example.com', length: 6 } }),
      [`POST ${base}/email`]: (body) => {
        const b = body as { action: string; code?: string }
        if (b.action === 'confirm' && b.code !== '424242') return json({ error: 'code_invalid', message: 'Неверный код' }, 422)
        state.info = info({ hasPassword: true, known: true, hasRecovery: b.action === 'confirm', recoveryEmail: b.action === 'confirm' ? 'me@example.com' : null })
        return new Response(null, { status: 204 })
      },
    })
    const user = userEvent.setup()
    renderWithClient(<CloudPasswordCard account={account} />)
    await user.click(await screen.findByRole('button', { name: 'Установить пароль' }))
    let dialog = screen.getByRole('dialog', { name: 'Новый облачный пароль' })
    await user.type(within(dialog).getByLabelText('Новый пароль'), 'p')
    await user.type(within(dialog).getByLabelText('Повтор пароля'), 'p')
    await user.type(within(dialog).getByLabelText('Почта для восстановления'), 'me@example.com')
    await user.click(within(dialog).getByRole('button', { name: 'Сохранить' }))

    dialog = await screen.findByRole('dialog', { name: 'Код из письма' })
    expect(within(dialog).getByText(/m\*\*\*@example\.com/)).toBeInTheDocument()
    await user.type(within(dialog).getByLabelText('Код'), '000000')
    await user.click(within(dialog).getByRole('button', { name: 'Подтвердить' }))
    expect(await within(dialog).findByText('Неверный код')).toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: 'Отправить ещё раз' }))
    await user.clear(within(dialog).getByLabelText('Код'))
    await user.type(within(dialog).getByLabelText('Код'), '424242')
    await user.click(within(dialog).getByRole('button', { name: 'Подтвердить' }))
    expect(await screen.findByText('me@example.com')).toBeInTheDocument()
    expect(calls(`POST ${base}/email`)).toEqual([{ action: 'confirm', code: '000000' }, { action: 'resend' }, { action: 'confirm', code: '424242' }])
  })

  it('offers to finish a recovery email that still waits for its code, even before the password is in force', async () => {
    const { calls } = api({ info: info({ hasPassword: false, unconfirmedEmailPattern: 'm***@example.com' }) })
    const user = userEvent.setup()
    renderWithClient(<CloudPasswordCard account={account} />)
    expect(await screen.findByText('ожидает подтверждения: m***@example.com')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Ввести код из письма' }))
    const dialog = screen.getByRole('dialog', { name: 'Код из письма' })
    await user.click(within(dialog).getByRole('button', { name: 'Пропустить' }))
    await waitFor(() => expect(calls(`POST ${base}/email`)).toEqual([{ action: 'cancel' }]))
  })

  it('shows validation and refusal messages in words, also when the form did not ask for the current password', async () => {
    const state = { info: info() }
    api(state, {
      [`PUT ${base}`]: () => {
        // Telegram has a password the card did not know about yet
        state.info = info({ hasPassword: true })
        return json({ error: 'password_unknown', message: 'Панель не знает текущий пароль — введите его' }, 409)
      },
      [`POST ${base}/email`]: () => json({ error: 'validation', fields: { code: 'Код — только цифры' } }, 400),
    })
    const user = userEvent.setup()
    renderWithClient(<CloudPasswordCard account={account} />)
    await user.click(await screen.findByRole('button', { name: 'Установить пароль' }))
    const dialog = screen.getByRole('dialog', { name: 'Новый облачный пароль' })
    await user.type(within(dialog).getByLabelText('Новый пароль'), 'p')
    await user.type(within(dialog).getByLabelText('Повтор пароля'), 'p')
    await user.click(within(dialog).getByRole('button', { name: 'Сохранить' }))
    expect(await within(dialog).findByText('Панель не знает текущий пароль — введите его')).toBeInTheDocument()
    // the card re-read the state: the form now asks for the current password
    expect(await within(dialog).findByLabelText('Текущий пароль')).toBeInTheDocument()
  })

  it('shows the email code check in words', async () => {
    api({ info: info({ hasPassword: true, known: true, unconfirmedEmailPattern: 'm***@example.com' }) }, { [`POST ${base}/email`]: () => json({ error: 'validation', fields: { code: 'Код — только цифры' } }, 400) })
    const user = userEvent.setup()
    renderWithClient(<CloudPasswordCard account={account} />)
    await user.click(await screen.findByRole('button', { name: 'Ввести код из письма' }))
    const dialog = screen.getByRole('dialog', { name: 'Код из письма' })
    await user.type(within(dialog).getByLabelText('Код'), '1')
    await user.click(within(dialog).getByRole('button', { name: 'Подтвердить' }))
    expect(await within(dialog).findByText('Код — только цифры')).toBeInTheDocument()
    expect(within(dialog).queryByText('HTTP 400')).not.toBeInTheDocument()
  })

  it('does not ask Telegram while the account is not connected', () => {
    const { fetchMock } = api({ info: info() })
    renderWithClient(<CloudPasswordCard account={accountFixture({ status: 'paused' })} />)
    expect(screen.getByText('Аккаунт не подключён — состояние облачного пароля недоступно')).toBeInTheDocument()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
