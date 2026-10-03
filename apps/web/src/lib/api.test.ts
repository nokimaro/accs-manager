import { afterEach, describe, expect, it, vi } from 'vitest'
import { api, ApiError } from './api'

afterEach(() => vi.unstubAllGlobals())

describe('api', () => {
  it('returns parsed JSON, and undefined for empty answers such as 202 Accepted', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(null, { status: 202 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(api('/x')).resolves.toEqual({ ok: true })
    await expect(api('/x', { method: 'POST' })).resolves.toBeUndefined()
    await expect(api('/x', { method: 'DELETE' })).resolves.toBeUndefined()
  })

  it('throws ApiError with the server message', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{"error":"not_running","message":"Аккаунт не подключён"}', { status: 409 })))
    const err = await api('/x').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect((err as ApiError).message).toBe('Аккаунт не подключён')
  })
})
