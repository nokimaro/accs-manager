import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Toaster } from '@workspace/ui/components/toast'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ImportProxiesDialog } from './import-proxies-dialog'

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

afterEach(() => vi.unstubAllGlobals())

function renderDialog() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <Toaster>
        <ImportProxiesDialog />
      </Toaster>
    </QueryClientProvider>,
  )
}

describe('ImportProxiesDialog', () => {
  it('previews the pasted list, shows problems by line and imports only after confirmation', async () => {
    const fetchMock = vi.fn(async (url: string) =>
      url.endsWith('/preview')
        ? json({
            proxies: [{ line: 1, type: 'socks5', host: '194.53.188.22', port: 50101, username: 'kz1' }],
            errors: [{ line: 2, text: 'garbage', reason: 'Ожидается host:port' }],
            duplicates: [{ line: 3, text: '1.1.1.1:80', reason: 'exists' }],
          })
        : json({ created: 1, skipped: 0 }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const user = userEvent.setup()
    renderDialog()

    await user.click(screen.getByRole('button', { name: 'Импорт списка' }))
    await user.type(screen.getByLabelText('Список'), 'socks5://kz1:pw@194.53.188.22:50101{enter}garbage{enter}1.1.1.1:80')
    await user.click(screen.getByRole('button', { name: 'Проверить список' }))

    expect(await screen.findByText('Новых: 1')).toBeInTheDocument()
    expect(screen.getByText('строка 2: Ожидается host:port')).toBeInTheDocument()
    expect(screen.getByText('строка 3: уже в пуле')).toBeInTheDocument()
    expect(fetchMock).toHaveBeenCalledTimes(1)

    await user.click(screen.getByRole('button', { name: 'Добавить 1' }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    const [url, init] = fetchMock.mock.calls[1] as unknown as [string, RequestInit]
    expect(url).toBe('/api/proxies/import')
    expect(JSON.parse(String(init.body))).toEqual({ text: 'socks5://kz1:pw@194.53.188.22:50101\ngarbage\n1.1.1.1:80', defaultType: 'socks5' })
    expect(await screen.findByText('Добавлено прокси: 1')).toBeInTheDocument()
  })

  it('forgets the pasted list (with passwords) when closed', async () => {
    vi.stubGlobal('fetch', vi.fn())
    const user = userEvent.setup()
    renderDialog()
    await user.click(screen.getByRole('button', { name: 'Импорт списка' }))
    await user.type(screen.getByLabelText('Список'), 'u:secret@1.1.1.1:80')
    await user.keyboard('{Escape}')
    await user.click(screen.getByRole('button', { name: 'Импорт списка' }))
    expect(screen.getByLabelText('Список')).toHaveValue('')
  })
})
