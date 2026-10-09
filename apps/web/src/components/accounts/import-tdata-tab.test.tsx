import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ImportBatchDto } from '@workspace/shared/accounts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { proxyFixture } from '@/test/fixtures'
import { json, renderWithClient } from '@/test/render'
import { ImportTdataTab } from './import-tdata-tab'

afterEach(() => vi.unstubAllGlobals())

const batch: ImportBatchDto = {
  id: '00000000-0000-4000-8000-0000000000b1',
  filename: 'tdata.zip',
  status: 'ready',
  createdAt: '2026-10-03T00:00:00.000Z',
  expiresAt: '2026-10-03T01:00:00.000Z',
  items: [
    { id: '00000000-0000-4000-8000-0000000000c1', pathInArchive: 'tdata', accountIndex: 0, tgUserId: 111, dcId: 2, duplicateOf: null, decision: 'pending', accountId: null },
    {
      id: '00000000-0000-4000-8000-0000000000c2',
      pathInArchive: 'tdata',
      accountIndex: 1,
      tgUserId: 222,
      dcId: 4,
      duplicateOf: { id: '00000000-0000-4000-8000-0000000000a9', label: 'old', phone: null },
      decision: 'pending',
      accountId: null,
    },
  ],
}

const zip = () => new File([new Uint8Array([0x50, 0x4b, 0x03, 0x04])], 'tdata.zip', { type: 'application/zip' })

describe('ImportTdataTab', () => {
  it('uploads the archive, proposes a free proxy for new accounts, skips duplicates and confirms', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/proxies') return json({ items: [proxyFixture()] })
      if (url === '/api/imports' && init?.method === 'POST') return json(batch, 201)
      return json({ created: 1, skipped: 1 })
    })
    vi.stubGlobal('fetch', fetchMock)
    const onDone = vi.fn()
    const user = userEvent.setup()
    renderWithClient(<ImportTdataTab onDone={onDone} />)

    await user.upload(screen.getByLabelText('Архив tdata (.zip)'), zip())
    await user.click(screen.getByRole('button', { name: 'Загрузить и проверить' }))

    expect(await screen.findByText(/найдено аккаунтов: 2/)).toBeInTheDocument()
    expect(screen.getByText('уже в панели')).toBeInTheDocument()
    expect(screen.getByLabelText('Подключение аккаунта 111')).toHaveTextContent('Свободный прокси автоматически')
    expect(screen.getByLabelText('Подключение аккаунта 222')).toHaveTextContent('Не добавлять')

    await user.click(screen.getByRole('button', { name: 'Добавить 1' }))
    await waitFor(() => expect(onDone).toHaveBeenCalled())
    const confirm = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/confirm')) as unknown as [string, RequestInit]
    expect(confirm[0]).toBe(`/api/imports/${batch.id}/confirm`)
    expect(JSON.parse(String(confirm[1].body))).toEqual({
      items: [
        { id: batch.items[0]!.id, decision: 'auto' },
        { id: batch.items[1]!.id, decision: 'skip' },
      ],
    })
  })

  it('shows a passcode error under the passcode field and sends the passcode on retry', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const form = init?.body as FormData
      return form.get('passcode') ? json(batch, 201) : json({ error: 'passcode_required', message: 'Архив защищён код-паролем — введите его' }, 400)
    })
    vi.stubGlobal('fetch', fetchMock)
    const user = userEvent.setup()
    renderWithClient(<ImportTdataTab onDone={vi.fn()} />)

    await user.upload(screen.getByLabelText('Архив tdata (.zip)'), zip())
    await user.click(screen.getByRole('button', { name: 'Загрузить и проверить' }))
    expect(await screen.findByText('Архив защищён код-паролем — введите его')).toBeInTheDocument()
    expect(screen.getByLabelText('Локальный код-пароль')).toHaveAttribute('aria-invalid', 'true')

    await user.type(screen.getByLabelText('Локальный код-пароль'), 'local-pass')
    await user.click(screen.getByRole('button', { name: 'Загрузить и проверить' }))
    expect(await screen.findByText(/найдено аккаунтов: 2/)).toBeInTheDocument()
  })

  it('without free proxies never picks «direct» on its own: new accounts default to skip', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => (url === '/api/proxies' ? json({ items: [] }) : json(batch, 201))),
    )
    const user = userEvent.setup()
    renderWithClient(<ImportTdataTab onDone={vi.fn()} />)
    await user.upload(screen.getByLabelText('Архив tdata (.zip)'), zip())
    await user.click(screen.getByRole('button', { name: 'Загрузить и проверить' }))

    expect(await screen.findByText('Свободных рабочих прокси нет')).toBeInTheDocument()
    expect(screen.getByLabelText('Подключение аккаунта 111')).toHaveTextContent('Не добавлять')
    expect(screen.getByRole('button', { name: 'Добавить 0' })).toBeDisabled()
  })

  it('with every proxy taken still defaults to skip, and offers to reuse the least loaded one', async () => {
    const busy = proxyFixture({ accounts: [{ id: 'x', label: 'другой', phone: null, username: null }] })
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/proxies') return json({ items: [busy] })
      if (url === '/api/imports' && init?.method === 'POST') return json(batch, 201)
      return json({ created: 1, skipped: 1 })
    })
    vi.stubGlobal('fetch', fetchMock)
    const onDone = vi.fn()
    const user = userEvent.setup()
    renderWithClient(<ImportTdataTab onDone={onDone} />)
    await user.upload(screen.getByLabelText('Архив tdata (.zip)'), zip())
    await user.click(screen.getByRole('button', { name: 'Загрузить и проверить' }))

    expect(await screen.findByText('Свободных рабочих прокси нет')).toBeInTheDocument()
    expect(screen.getByText(/Выберите «Переиспользовать прокси»/)).toBeInTheDocument()
    expect(screen.getByLabelText('Подключение аккаунта 111')).toHaveTextContent('Не добавлять')

    await user.click(screen.getByLabelText('Подключение аккаунта 111'))
    // a taken proxy can be picked by hand too, showing how many accounts it carries
    expect(await screen.findByRole('option', { name: /194\.53\.188\.10:50101 .*· 1 акк\./ })).toBeInTheDocument()
    await user.click(screen.getByRole('option', { name: 'Переиспользовать прокси — наименее загруженный' }))
    await user.click(screen.getByRole('button', { name: 'Добавить 1' }))
    await waitFor(() => expect(onDone).toHaveBeenCalled())
    const confirm = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/confirm')) as unknown as [string, RequestInit]
    expect(JSON.parse(String(confirm[1].body)).items[0]).toEqual({ id: batch.items[0]!.id, decision: 'reuse' })
  })
})
