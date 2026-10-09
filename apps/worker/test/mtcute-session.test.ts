import { beforeEach, describe, expect, it, vi } from 'vitest'

const client = {
  importSession: vi.fn(async () => {}),
  connect: vi.fn(async () => {}),
  getMe: vi.fn(async () => ({ id: 42, phoneNumber: '77001234567', username: null, firstName: 'Тест', lastName: null, isPremium: false, dcId: 2, raw: { _: 'user', id: 42 } })),
  notifyLoggedIn: vi.fn(async () => {}),
  setOnline: vi.fn(async (_online?: boolean) => {}),
  destroy: vi.fn(async () => {}),
}
vi.mock('@mtcute/node', () => ({ TelegramClient: vi.fn(function TelegramClient() { return client }) }))

const { createMtcuteSession } = await import('../src/telegram/mtcute-session.ts')

const options = {
  apiId: 2040,
  apiHash: 'hash',
  device: { deviceModel: 'Desktop', systemVersion: 'Windows 11 x64', appVersion: '7.2.9 x64', langCode: 'ru' },
  storage: {} as never,
  proxy: null,
  online: true,
}

beforeEach(() => vi.clearAllMocks())

describe('mtcute session', () => {
  it('starts the updates loop after connecting: without it no live messages arrive', async () => {
    const profile = await createMtcuteSession({ ...options, importSession: null }).start()
    expect(client.connect).toHaveBeenCalled()
    expect(client.notifyLoggedIn).toHaveBeenCalledWith({ _: 'user', id: 42 })
    expect(profile).toEqual({ tgUserId: 42, phone: '77001234567', username: null, firstName: 'Тест', lastName: null, isPremium: false, dcId: 2 })
    expect(client.importSession).not.toHaveBeenCalled()
  })

  it('applies an imported session before connecting', async () => {
    await createMtcuteSession({ ...options, importSession: 'session-string' }).start()
    expect(client.importSession).toHaveBeenCalledWith('session-string', true)
    expect(client.importSession.mock.invocationCallOrder[0]!).toBeLessThan(client.connect.mock.invocationCallOrder[0]!)
  })

  it('does not report a logged-in client when the session is dead', async () => {
    client.getMe.mockRejectedValueOnce(Object.assign(new Error('AUTH_KEY_UNREGISTERED'), { code: 401 }))
    await expect(createMtcuteSession({ ...options, importSession: null }).start()).rejects.toThrow('AUTH_KEY_UNREGISTERED')
    expect(client.notifyLoggedIn).not.toHaveBeenCalled()
  })

  it('marks the account online after connecting, like an open Telegram Desktop: Gateway delivers codes only then', async () => {
    await createMtcuteSession({ ...options, importSession: null }).start()
    expect(client.setOnline).toHaveBeenCalledWith(true)
    expect(client.setOnline.mock.invocationCallOrder[0]!).toBeGreaterThan(client.notifyLoggedIn.mock.invocationCallOrder[0]!)
  })

  it('stays as it was with online presence turned off', async () => {
    const session = createMtcuteSession({ ...options, importSession: null, online: false })
    await session.start()
    await session.stop()
    expect(client.setOnline).not.toHaveBeenCalled()
    expect(client.destroy).toHaveBeenCalled()
  })

  it('goes offline before disconnecting, and disconnects even when Telegram does not answer', async () => {
    const session = createMtcuteSession({ ...options, importSession: null })
    await session.start()
    await session.stop()
    expect(client.setOnline).toHaveBeenLastCalledWith(false)
    expect(client.setOnline.mock.invocationCallOrder.at(-1)!).toBeLessThan(client.destroy.mock.invocationCallOrder[0]!)

    vi.useFakeTimers()
    try {
      client.setOnline.mockImplementationOnce(() => new Promise(() => {}))
      const stopping = createMtcuteSession({ ...options, importSession: null }).stop()
      await vi.advanceTimersByTimeAsync(5_000)
      await stopping
      expect(client.destroy).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })
})
