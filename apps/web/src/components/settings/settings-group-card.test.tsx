import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { SettingsResponse } from '@workspace/shared/api'
import { settingGroups, settingsDef, type SettingKey } from '@workspace/shared/settings'
import { Toaster } from '@workspace/ui/components/toast'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SettingsGroupCard } from './settings-group-card'

function snapshot(overrides: Partial<Record<SettingKey, Partial<SettingsResponse['items'][string]>>> = {}): SettingsResponse {
  const items: SettingsResponse['items'] = {}
  for (const key of Object.keys(settingsDef) as SettingKey[]) {
    const isSecret = settingsDef[key].meta.type === 'secret'
    const value = isSecret ? null : settingsDef[key].default
    items[key] = { value, isSet: value !== null, overridden: false, updatedAt: null, updatedBy: null, ...overrides[key] }
  }
  return { items }
}

function renderGroup(groupId: (typeof settingGroups)[number]['id'], data = snapshot()) {
  const group = settingGroups.find((g) => g.id === groupId)!
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <Toaster>
        <SettingsGroupCard group={group} data={data} />
      </Toaster>
    </QueryClientProvider>,
  )
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

afterEach(() => vi.unstubAllGlobals())

describe('SettingsGroupCard', () => {
  it('validates with the shared schema and blocks saving invalid values', async () => {
    const user = userEvent.setup()
    renderGroup('worker')
    const input = screen.getByLabelText('Параллельных подключений')
    await user.clear(input)
    await user.type(input, '0')
    expect(await screen.findByText('Не меньше 1')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Сохранить' })).toBeDisabled()
  })

  it('sends only changed keys and toggles booleans', async () => {
    const fetchMock = vi.fn(async () => json(snapshot()))
    vi.stubGlobal('fetch', fetchMock)
    const user = userEvent.setup()
    renderGroup('notifications')
    await user.click(screen.getByRole('switch', { name: 'Уведомления включены' }))
    await user.click(screen.getByRole('checkbox', { name: 'Аккаунт заморожен' }))
    await user.click(screen.getByRole('button', { name: 'Сохранить' }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('/api/settings')
    expect(init.method).toBe('PATCH')
    expect(JSON.parse(String(init.body))).toEqual({
      changes: { 'notify.enabled': true, 'notify.events': ['code', 'proxy_down', 'unauthorized', 'banned', 'proxy_expiring'] },
    })
  })

  it('replaces and clears secrets without ever showing the stored value', async () => {
    const fetchMock = vi.fn(async () => json(snapshot()))
    vi.stubGlobal('fetch', fetchMock)
    const user = userEvent.setup()
    renderGroup('notifications', snapshot({ 'notify.botToken': { isSet: true, overridden: true } }))
    expect(screen.getByPlaceholderText('Задан')).toBeDisabled()
    await user.click(screen.getByRole('button', { name: 'Очистить' }))
    expect(screen.getByPlaceholderText('Будет очищен')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Сохранить' }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(JSON.parse(String(init.body))).toEqual({ changes: { 'notify.botToken': null } })
  })

  it('shows server-side field errors from a 400', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ error: 'validation', fields: { 'proxy.failThreshold': 'Слишком много' } }, 400)))
    const user = userEvent.setup()
    renderGroup('proxy')
    const input = screen.getByLabelText('Неудач подряд до «dead»')
    await user.clear(input)
    await user.type(input, '7')
    await user.click(screen.getByRole('button', { name: 'Сохранить' }))
    expect(await screen.findByText('Слишком много')).toBeInTheDocument()
  })

  it('sends a replaced secret and keeps Save disabled while it is empty', async () => {
    const fetchMock = vi.fn(async () => json(snapshot()))
    vi.stubGlobal('fetch', fetchMock)
    const user = userEvent.setup()
    renderGroup('notifications')
    await user.click(screen.getByRole('button', { name: 'Задать' }))
    expect(screen.getByRole('button', { name: 'Сохранить' })).toBeDisabled()
    expect(screen.queryByText(/Пустое значение/)).not.toBeInTheDocument()
    await user.type(screen.getByLabelText('Токен бота'), '42:NEW')
    await user.click(screen.getByRole('button', { name: 'Сохранить' }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(JSON.parse(String(init.body))).toEqual({ changes: { 'notify.botToken': '42:NEW' } })
  })

  it('turns clearing a nullable field into a reset and drops server errors on cancel', async () => {
    const fetchMock = vi.fn(async () => json({ error: 'validation', fields: { 'notify.chatId': 'Плохой ID' } }, 400))
    vi.stubGlobal('fetch', fetchMock)
    const user = userEvent.setup()
    renderGroup('notifications', snapshot({ 'notify.chatId': { value: '-100', isSet: true, overridden: true } }))
    await user.clear(screen.getByLabelText('ID канала'))
    await user.click(screen.getByRole('button', { name: 'Сохранить' }))
    expect(await screen.findByText('Плохой ID')).toBeInTheDocument()
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(JSON.parse(String(init.body))).toEqual({ changes: { 'notify.chatId': null } })
    await user.click(screen.getByRole('button', { name: 'Отменить изменения' }))
    expect(screen.queryByText('Плохой ID')).not.toBeInTheDocument()
  })

  it('explains a setting in the ⓘ popover and names its unit', async () => {
    const user = userEvent.setup()
    renderGroup('retention')
    expect(screen.getByText('Сколько хранить полученные коды в панели.')).toBeInTheDocument()
    expect(screen.getByText('В днях: от 1 до 3650.')).toBeInTheDocument()
    expect(screen.getByText('дней')).toBeInTheDocument()
    const input = screen.getByLabelText('Хранить коды')
    await user.clear(input)
    await user.type(input, '1')
    expect(screen.getByText('день')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Подробнее: Хранить коды' }))
    expect(await screen.findByText(/старше этого срока удаляются автоматически/)).toBeInTheDocument()
  })

  it('spells out durations in words', () => {
    renderGroup('proxy')
    expect(screen.getByText('Длительность: 30s, 5m, 6h, 7d (с, мин, ч, дн.); от 1 минуты до 1 дня. Сейчас: 5 минут.')).toBeInTheDocument()
  })
})
