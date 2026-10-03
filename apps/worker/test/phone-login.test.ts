import { randomUUID } from 'node:crypto'
import { accounts, eq } from '@workspace/db'
import type { AppEvent } from '@workspace/shared/events'
import { loginControlChannel } from '@workspace/shared/commands'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PhoneClient, PhoneClientFactory, SentCodeInfo } from '../src/login/phone-client.ts'
import { createPhoneLogin } from '../src/login/phone.ts'
import type { SessionProfile } from '../src/telegram/session.ts'
import { rpcError } from './fake-session.ts'
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

const sent = (over: Partial<SentCodeInfo> = {}): SentCodeInfo => ({ phoneCodeHash: 'hash-1', deliveryType: 'app', codeLength: 5, nextType: 'sms', timeoutSec: 60, ...over })
const profile = (tgUserId: number): SessionProfile => ({ tgUserId, phone: '77001234567', username: null, firstName: 'Phone', lastName: null, isPremium: false, dcId: 2 })

type FakePhoneClient = PhoneClient & { destroyed: boolean; loggedOut: boolean; cancelled: boolean; calls: string[] }

/** Telegram as the test scripts it: the right code is 12345, the right cloud password «right» (if `twoFa`). */
function scripted(
  tgUserId: number,
  opts: { twoFa?: boolean; sendCode?: (signal?: AbortSignal) => Promise<SentCodeInfo | SessionProfile>; signInDelayMs?: number } = {},
) {
  const made: FakePhoneClient[] = []
  const factory: PhoneClientFactory = () => {
    let expired = false
    const client: FakePhoneClient = {
      destroyed: false,
      loggedOut: false,
      cancelled: false,
      calls: [],
      sendCode: async (phone, signal) => {
        client.calls.push(`sendCode ${phone}`)
        return opts.sendCode ? opts.sendCode(signal) : sent()
      },
      resendCode: async () => {
        client.calls.push('resendCode')
        expired = false
        return sent({ phoneCodeHash: 'hash-2', deliveryType: 'sms', nextType: 'call' })
      },
      signIn: async (_phone, hash, code) => {
        client.calls.push(`signIn ${hash} ${code}`)
        // Telegram may finish authorizing even though the admin cancelled meanwhile
        if (opts.signInDelayMs) await new Promise((r) => setTimeout(r, opts.signInDelayMs))
        if (code === '00000') {
          expired = true
          throw rpcError(400, 'PHONE_CODE_EXPIRED')
        }
        if (expired || code !== '12345') throw rpcError(400, 'PHONE_CODE_INVALID')
        if (opts.twoFa) throw rpcError(401, 'SESSION_PASSWORD_NEEDED')
        return profile(tgUserId)
      },
      checkPassword: async (password) => {
        client.calls.push('checkPassword')
        if (password !== 'right') throw rpcError(400, 'PASSWORD_HASH_INVALID')
        return profile(tgUserId)
      },
      cancelCode: async () => {
        client.cancelled = true
      },
      passwordHint: async () => 'кличка кота',
      exportSession: async () => 'phone-session',
      logOut: async () => {
        client.loggedOut = true
      },
      destroy: async () => {
        client.destroyed = true
      },
    }
    made.push(client)
    return client
  }
  return { factory, made }
}

async function collect(loginId: string) {
  const states: Extract<AppEvent, { type: 'phone.update' }>[] = []
  const off = w.deps.bus.subscribe((e) => {
    if (e.type === 'phone.update' && e.loginId === loginId) states.push(e)
  })
  return { states, off, names: () => states.map((s) => s.state) }
}
const send = (loginId: string, message: unknown) => w.deps.redis.publish(loginControlChannel(loginId), JSON.stringify(message))
const start = (loginId: string) => ({ loginId, phone: '77001234567', proxyId: null, adminId: null })

describe('phone login', () => {
  it('takes the code (wrong first) and the cloud password (wrong first), then saves the account with its session and password', async () => {
    const loginId = randomUUID()
    const { factory, made } = scripted(61001, { twoFa: true })
    const destroyedAtHandOff: boolean[] = []
    const onAccountCreated = vi.fn(() => {
      destroyedAtHandOff.push(made[0]!.destroyed)
    })
    const { states, off, names } = await collect(loginId)
    const run = createPhoneLogin(w.deps, factory, { onAccountCreated }).run(start(loginId))

    await vi.waitFor(() => expect(names()).toContain('code_sent'))
    expect(states[0]).toMatchObject({ state: 'code_sent', deliveryType: 'app', codeLength: 5, nextType: 'sms', retryAfterSec: 60 })
    await send(loginId, { type: 'code', code: '11111' })
    await vi.waitFor(() => expect(names()).toContain('code_invalid'))
    await send(loginId, { type: 'code', code: '12345' })
    await vi.waitFor(() => expect(names()).toContain('password_needed'))
    await send(loginId, { type: 'password', password: 'wrong' })
    await vi.waitFor(() => expect(names()).toContain('password_invalid'))
    await send(loginId, { type: 'password', password: 'right' })
    await run
    await vi.waitFor(() => expect(states.at(-1)).toMatchObject({ state: 'done' }))
    off()

    expect(names()).toEqual(['code_sent', 'code_invalid', 'password_needed', 'password_invalid', 'done'])
    expect(states[2]).toMatchObject({ hint: 'кличка кота' })
    expect(states[3]).toMatchObject({ hint: 'кличка кота' })
    const [account] = await w.t.db.select().from(accounts).where(eq(accounts.tgUserId, 61001))
    expect(account).toMatchObject({ source: 'phone', clientProfile: 'own', connectionMode: 'direct', status: 'pending_check' })
    expect(w.deps.cipher.decrypt(account!.sessionImportEnc!)).toBe('phone-session')
    expect(w.deps.cipher.decrypt(account!.cloudPasswordEnc!)).toBe('right')
    expect(onAccountCreated).toHaveBeenCalledWith(account!.id)
    expect(destroyedAtHandOff).toEqual([true])
    expect(made[0]!.calls[0]).toBe('sendCode 77001234567')
  })

  it('sends the code again by the next method, and after an expired code takes the new one', async () => {
    const loginId = randomUUID()
    const { factory, made } = scripted(61002)
    const { states, off, names } = await collect(loginId)
    const run = createPhoneLogin(w.deps, factory).run(start(loginId))
    await vi.waitFor(() => expect(names()).toContain('code_sent'))
    await send(loginId, { type: 'code', code: '00000' })
    await vi.waitFor(() => expect(names()).toContain('code_expired'))
    await send(loginId, { type: 'resend' })
    await vi.waitFor(() => expect(names().filter((n) => n === 'code_sent')).toHaveLength(2))
    expect(states.at(-1)).toMatchObject({ deliveryType: 'sms', nextType: 'call' })
    await send(loginId, { type: 'code', code: '12345' })
    await run
    await vi.waitFor(() => expect(states.at(-1)).toMatchObject({ state: 'done' }))
    off()
    expect(made[0]!.calls).toContain('signIn hash-2 12345')
    const [account] = await w.t.db.select().from(accounts).where(eq(accounts.tgUserId, 61002))
    expect(account).toMatchObject({ source: 'phone', cloudPasswordEnc: null })
  })

  it('refuses an account that is already in the panel and logs the new session out', async () => {
    const device = { deviceModel: 'Desktop', systemVersion: 'Windows 11 x64', appVersion: '7.2.9 x64', langCode: 'ru' }
    const [existing] = await w.t.db.insert(accounts).values({ tgUserId: 61003, source: 'tdata', clientProfile: 'desktop', device, connectionMode: 'direct' }).returning()
    const loginId = randomUUID()
    const { factory, made } = scripted(61003)
    const { states, off, names } = await collect(loginId)
    const run = createPhoneLogin(w.deps, factory).run(start(loginId))
    await vi.waitFor(() => expect(names()).toContain('code_sent'))
    await send(loginId, { type: 'code', code: '12345' })
    await run
    await vi.waitFor(() => expect(states.at(-1)).toMatchObject({ state: 'failed', accountId: existing!.id, message: 'Этот аккаунт уже есть в панели' }))
    off()
    expect(made[0]!.loggedOut).toBe(true)
    expect(made[0]!.destroyed).toBe(true)
    expect(await w.t.db.select().from(accounts)).toHaveLength(1)
  })

  it('stops on cancel (asking Telegram to cancel the code) and on timeout', async () => {
    const cancelId = randomUUID()
    const first = scripted(61004)
    const cancelled = await collect(cancelId)
    const run = createPhoneLogin(w.deps, first.factory).run(start(cancelId))
    await vi.waitFor(() => expect(cancelled.names()).toContain('code_sent'))
    await send(cancelId, { type: 'cancel' })
    await run
    await vi.waitFor(() => expect(cancelled.states.at(-1)).toMatchObject({ state: 'cancelled' }))
    cancelled.off()
    expect(first.made[0]!.cancelled).toBe(true)
    expect(first.made[0]!.destroyed).toBe(true)

    const timeoutId = randomUUID()
    const second = scripted(61005)
    const timedOut = await collect(timeoutId)
    await createPhoneLogin(w.deps, second.factory, { timeoutMs: 80 }).run(start(timeoutId))
    await vi.waitFor(() => expect(timedOut.states.at(-1)).toMatchObject({ state: 'expired' }))
    timedOut.off()
    expect(await w.t.db.select().from(accounts)).toHaveLength(0)
  })

  it('logs in at once when Telegram authorizes without a code', async () => {
    const loginId = randomUUID()
    const { factory } = scripted(61006, { sendCode: async () => profile(61006) })
    const { states, off } = await collect(loginId)
    await createPhoneLogin(w.deps, factory).run(start(loginId))
    await vi.waitFor(() => expect(states.at(-1)).toMatchObject({ state: 'done' }))
    off()
    expect(states.map((s) => s.state)).toEqual(['done'])
  })

  it('explains what Telegram refused', async () => {
    const cases: [() => Promise<SentCodeInfo | SessionProfile>, string][] = [
      [async () => Promise.reject(rpcError(400, 'PHONE_NUMBER_INVALID')), 'Неверный номер'],
      [async () => Promise.reject(rpcError(400, 'PHONE_NUMBER_BANNED')), 'Номер заблокирован Telegram'],
      [async () => Promise.reject(rpcError(400, 'PHONE_NUMBER_UNOCCUPIED')), 'На этот номер нет аккаунта Telegram — регистрация через панель не поддерживается'],
      [
        async () => Promise.reject(Object.assign(rpcError(420, 'FLOOD_WAIT_%d'), { seconds: 600 })),
        'Слишком много попыток — подождите 10 мин',
      ],
      [async () => sent({ deliveryType: 'email_required' }), 'Telegram требует привязать почту для входа — сделайте это в официальном приложении'],
      [
        async () => Promise.reject(new Error('Payment is required to sign in, please log in with a first-party client first')),
        'Telegram требует платный вход для неофициальных приложений — войдите сначала в официальном',
      ],
    ]
    for (const [sendCode, message] of cases) {
      const loginId = randomUUID()
      const { factory } = scripted(61007, { sendCode })
      const { states, off } = await collect(loginId)
      await createPhoneLogin(w.deps, factory).run(start(loginId))
      await vi.waitFor(() => expect(states.at(-1)).toMatchObject({ state: 'failed', message }))
      off()
    }
  })

  it('needs the own api_id', async () => {
    await w.deps.settings.update({ 'telegram.own.apiId': null }, { adminId: null })
    try {
      const loginId = randomUUID()
      const { factory, made } = scripted(61008)
      const { states, off } = await collect(loginId)
      await createPhoneLogin(w.deps, factory).run(start(loginId))
      await vi.waitFor(() => expect(states.at(-1)).toMatchObject({ state: 'failed', message: 'Не задан свой api_id / api_hash (Настройки → Telegram)' }))
      off()
      expect(made).toHaveLength(0)
    } finally {
      await w.deps.settings.update({ 'telegram.own.apiId': 123456 }, { adminId: null })
    }
  })

  it('gives up a login whose Telegram call never answers, on timeout, destroying the client', async () => {
    const loginId = randomUUID()
    // like mtcute: an RPC that never gets an answer ends only through its abort signal
    const hanging = (signal?: AbortSignal) =>
      new Promise<SentCodeInfo>((_, reject) => signal?.addEventListener('abort', () => reject(signal.reason), { once: true }))
    const { factory, made } = scripted(61009, { sendCode: hanging })
    const { states, off } = await collect(loginId)
    const run = createPhoneLogin(w.deps, factory, { timeoutMs: 80 }).run(start(loginId))
    const outcome = await Promise.race([run.then(() => 'ended'), new Promise((r) => setTimeout(() => r('hung'), 2_000))])
    expect(outcome).toBe('ended')
    await vi.waitFor(() => expect(states.at(-1)).toMatchObject({ state: 'expired' }))
    off()
    expect(made[0]!.destroyed).toBe(true)
  })

  it('drops a session Telegram authorized after the admin cancelled', async () => {
    const loginId = randomUUID()
    const { factory, made } = scripted(61010, { signInDelayMs: 150 })
    const { states, off, names } = await collect(loginId)
    const run = createPhoneLogin(w.deps, factory).run(start(loginId))
    await vi.waitFor(() => expect(names()).toContain('code_sent'))
    await send(loginId, { type: 'code', code: '12345' })
    await vi.waitFor(() => expect(made[0]!.calls.some((c) => c.startsWith('signIn'))).toBe(true))
    await send(loginId, { type: 'cancel' })
    await run
    await vi.waitFor(() => expect(states.at(-1)).toMatchObject({ state: 'cancelled' }))
    off()
    expect(made[0]!.loggedOut).toBe(true)
    expect(await w.t.db.select().from(accounts).where(eq(accounts.tgUserId, 61010))).toHaveLength(0)
  })
})

