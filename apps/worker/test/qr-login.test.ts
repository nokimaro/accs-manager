import { randomUUID } from 'node:crypto'
import { accounts, eq } from '@workspace/db'
import type { AppEvent } from '@workspace/shared/events'
import { qrControlChannel } from '@workspace/shared/commands'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { QrClient, QrClientFactory, QrSignInParams } from '../src/qr/client.ts'
import { createQrLogin } from '../src/qr/login.ts'
import { setupWorker, type TestWorker } from './helpers.ts'

let w: TestWorker
beforeAll(async () => {
  w = await setupWorker()
  await w.deps.settings.update({ 'telegram.own.apiId': 123456, 'telegram.own.apiHash': '0123456789abcdef0123456789abcdef' }, { adminId: null })
})
afterAll(async () => {
  await w.close()
})
beforeEach(async () => {
  await w.t.db.delete(accounts)
})

/** Scripted login: shows a QR, gets scanned, asks for 2FA (wrong once), succeeds as `userId`. */
function scriptedFactory(userId: number, opts: { twoFa?: boolean; hang?: boolean } = {}) {
  const made: (QrClient & { loggedOut: boolean; destroyed: boolean })[] = []
  const factory: QrClientFactory = () => {
    const client = {
      loggedOut: false,
      destroyed: false,
      async signIn(p: QrSignInParams) {
        p.onUrlUpdated('tg://login?token=abc', new Date(Date.now() + 30_000))
        if (opts.hang) {
          await new Promise((_, reject) => p.abortSignal.addEventListener('abort', () => reject(p.abortSignal.reason), { once: true }))
        }
        p.onQrScanned()
        if (opts.twoFa) {
          if ((await p.password()) !== 'right') {
            p.invalidPasswordCallback()
            if ((await p.password()) !== 'right') throw new Error('PASSWORD_HASH_INVALID')
          }
        }
        return { tgUserId: userId, phone: '77009998877', username: 'qr_user', firstName: 'QR', lastName: null, isPremium: false, dcId: 2 }
      },
      passwordHint: async () => 'кличка кота',
      exportSession: async () => 'exported-session',
      async logOut() {
        client.loggedOut = true
      },
      async destroy() {
        client.destroyed = true
      },
    }
    made.push(client)
    return client
  }
  return { factory, made }
}

async function collect(qrId: string) {
  const states: AppEvent[] = []
  const off = w.deps.bus.subscribe((e) => {
    if (e.type === 'qr.update' && e.qrId === qrId) states.push(e)
  })
  return { states, off }
}
const sendControl = (qrId: string, message: unknown) => w.deps.redis.publish(qrControlChannel(qrId), JSON.stringify(message))

describe('QR login', () => {
  it('walks through QR, scan and 2FA, then saves the account with its session and starts it', async () => {
    const qrId = randomUUID()
    const { factory, made } = scriptedFactory(31337, { twoFa: true })
    // one auth key — one client: the QR client must be gone before the worker starts the account
    const destroyedAtHandOff: boolean[] = []
    const onAccountCreated = vi.fn(() => {
      destroyedAtHandOff.push(made[0]!.destroyed)
    })
    const { states, off } = await collect(qrId)
    const login = createQrLogin(w.deps, factory, { onAccountCreated })
    const run = login.run({ qrId, proxyId: null, adminId: null })
    await vi.waitFor(() => expect(states.map((s) => (s as { state: string }).state)).toContain('password_needed'))
    await sendControl(qrId, { type: 'password', password: 'wrong' })
    await vi.waitFor(() => expect(states.map((s) => (s as { state: string }).state)).toContain('password_invalid'))
    await sendControl(qrId, { type: 'password', password: 'right' })
    await run
    // events travel through Redis pub/sub: wait for the last one before looking
    await vi.waitFor(() => expect(states.at(-1)).toMatchObject({ state: 'done' }))
    off()

    const [account] = await w.t.db.select().from(accounts).where(eq(accounts.tgUserId, 31337))
    expect(account).toMatchObject({ source: 'qr', clientProfile: 'own', connectionMode: 'direct', status: 'pending_check', phone: '77009998877' })
    expect(w.deps.cipher.decrypt(account!.sessionImportEnc!)).toBe('exported-session')
    // the cloud password that let the login through is kept (encrypted) for the account card
    expect(w.deps.cipher.decrypt(account!.cloudPasswordEnc!)).toBe('right')
    expect(onAccountCreated).toHaveBeenCalledWith(account!.id)
    // «неверный пароль» stays on screen (with the hint) until the next try — mtcute asks for the password right after
    expect(states.map((s) => (s as { state: string }).state)).toEqual(['waiting', 'scanned', 'password_needed', 'password_invalid', 'done'])
    expect(states[0]).toMatchObject({ url: 'tg://login?token=abc' })
    expect(states[2]).toMatchObject({ hint: 'кличка кота' })
    expect(states[3]).toMatchObject({ hint: 'кличка кота' })
    expect(destroyedAtHandOff).toEqual([true])
  })

  it('keeps no cloud password for an account without one', async () => {
    const qrId = randomUUID()
    const { factory } = scriptedFactory(52525)
    await createQrLogin(w.deps, factory).run({ qrId, proxyId: null, adminId: null })
    const [account] = await w.t.db.select().from(accounts).where(eq(accounts.tgUserId, 52525))
    expect(account).toMatchObject({ source: 'qr', cloudPasswordEnc: null })
  })

  it('logs the new session out when the account is already in the panel', async () => {
    const device = { deviceModel: 'Desktop', systemVersion: 'Windows 11 x64', appVersion: '7.2.9 x64', langCode: 'ru' }
    const [existing] = await w.t.db.insert(accounts).values({ tgUserId: 4242, source: 'tdata', clientProfile: 'desktop', device, connectionMode: 'direct' }).returning()
    const qrId = randomUUID()
    const { factory, made } = scriptedFactory(4242)
    const { states, off } = await collect(qrId)
    await createQrLogin(w.deps, factory).run({ qrId, proxyId: null, adminId: null })
    await vi.waitFor(() => expect(states.at(-1)).toMatchObject({ state: 'failed', accountId: existing!.id, message: 'Этот аккаунт уже есть в панели' }))
    off()
    expect(made[0]!.loggedOut).toBe(true)
    expect(await w.t.db.select().from(accounts)).toHaveLength(1)
    expect(made[0]!.destroyed).toBe(true)
  })

  it('stops on cancel and on timeout', async () => {
    const cancelId = randomUUID()
    const cancelled = await collect(cancelId)
    const running = createQrLogin(w.deps, scriptedFactory(1, { hang: true }).factory).run({ qrId: cancelId, proxyId: null, adminId: null })
    await vi.waitFor(() => expect(cancelled.states).toHaveLength(1))
    await sendControl(cancelId, { type: 'cancel' })
    await running
    await vi.waitFor(() => expect(cancelled.states.at(-1)).toMatchObject({ state: 'cancelled' }))
    cancelled.off()

    const timeoutId = randomUUID()
    const expired = await collect(timeoutId)
    await createQrLogin(w.deps, scriptedFactory(2, { hang: true }).factory, { timeoutMs: 100 }).run({ qrId: timeoutId, proxyId: null, adminId: null })
    await vi.waitFor(() => expect(expired.states.at(-1)).toMatchObject({ state: 'expired' }))
    expired.off()
  })

  it('refuses to start without the own api_id', async () => {
    await w.deps.settings.update({ 'telegram.own.apiId': null }, { adminId: null })
    const qrId = randomUUID()
    const { states, off } = await collect(qrId)
    await createQrLogin(w.deps, scriptedFactory(1).factory).run({ qrId, proxyId: null, adminId: null })
    await vi.waitFor(() => expect(states).toEqual([expect.objectContaining({ state: 'failed', message: 'Не задан свой api_id / api_hash (Настройки → Telegram)' })]))
    off()
    await w.deps.settings.update({ 'telegram.own.apiId': 123456 }, { adminId: null })
  })
})
