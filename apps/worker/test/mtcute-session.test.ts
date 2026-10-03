import { beforeEach, describe, expect, it, vi } from 'vitest'

const client = {
  importSession: vi.fn(async () => {}),
  connect: vi.fn(async () => {}),
  getMe: vi.fn(async () => ({ id: 42, phoneNumber: '77001234567', username: null, firstName: 'Тест', lastName: null, isPremium: false, dcId: 2, raw: { _: 'user', id: 42 } })),
  notifyLoggedIn: vi.fn(async () => {}),
}
vi.mock('@mtcute/node', () => ({ TelegramClient: vi.fn(function TelegramClient() { return client }) }))

const { createMtcuteSession } = await import('../src/telegram/mtcute-session.ts')

const options = {
  apiId: 2040,
  apiHash: 'hash',
  device: { deviceModel: 'Desktop', systemVersion: 'Windows 11 x64', appVersion: '7.2.9 x64', langCode: 'ru' },
  storage: {} as never,
  proxy: null,
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
})
