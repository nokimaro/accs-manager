import type * as React from 'react'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { accountFixture } from '@/test/fixtures'
import { json, renderWithClient } from '@/test/render'
import { TestCodePanel } from './test-code-panel'

vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  Link: ({ to, children, className }: { to: string; children: React.ReactNode; className?: string }) => (
    <a href={to} className={className}>
      {children}
    </a>
  ),
}))

afterEach(() => vi.unstubAllGlobals())

const account = accountFixture()
const settings = (isSet: boolean) => json({ items: { 'gateway.token': { value: null, isSet, isDefault: !isSet, updatedAt: null, updatedBy: null } } })

describe('TestCodePanel', () => {
  it('sends a test code and follows its delivery until Telegram reports it delivered', async () => {
    let checks = 0
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/settings') return settings(true)
      if (init?.method === 'POST') return json({ requestId: '42', delivery: 'sent', cost: 0.01, remainingBalance: 95.79 })
      checks++
      return json({ requestId: '42', delivery: checks < 2 ? 'sent' : 'delivered', cost: 0.01, remainingBalance: null })
    })
    vi.stubGlobal('fetch', fetchMock)
    const user = userEvent.setup()
    renderWithClient(<TestCodePanel account={account} pollMs={20} />)

    const button = await screen.findByRole('button', { name: 'Отправить тестовый код' })
    await waitFor(() => expect(button).toBeEnabled())
    await user.click(button)
    expect(await screen.findByRole('status')).toHaveTextContent('Отправлен через Telegram Gateway за 0,01, на балансе 95,79. Доставка: отправлен')
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Доставка: доставлен'))
    expect(fetchMock).toHaveBeenCalledWith(`/api/accounts/${account.id}/test-code`, expect.objectContaining({ method: 'POST' }))
    expect(fetchMock).toHaveBeenCalledWith(`/api/accounts/${account.id}/test-code/42`, expect.anything())
    // settled: no more polling
    const after = fetchMock.mock.calls.length
    await new Promise((r) => setTimeout(r, 100))
    expect(fetchMock.mock.calls.length).toBe(after)
  })

  it('shows Gateway’s refusal in words', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url === '/api/settings'
          ? settings(true)
          : json({ error: 'gateway_not_available', message: 'Telegram не доставит код на этот номер: аккаунт давно не был в сети' }, 409),
      ),
    )
    const user = userEvent.setup()
    renderWithClient(<TestCodePanel account={account} />)
    const button = await screen.findByRole('button', { name: 'Отправить тестовый код' })
    await waitFor(() => expect(button).toBeEnabled())
    await user.click(button)
    expect(await screen.findByText('Тестовый код не отправлен')).toBeInTheDocument()
    expect(screen.getByText(/аккаунт давно не был в сети/)).toBeInTheDocument()
  })

  it('without a Gateway token the button is off and points to the settings', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => settings(false)))
    renderWithClient(<TestCodePanel account={account} />)
    expect(await screen.findByText(/Нужен токен Telegram Gateway/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Настройки' })).toHaveAttribute('href', '/settings')
    expect(screen.getByRole('button', { name: 'Отправить тестовый код' })).toBeDisabled()
  })
})
