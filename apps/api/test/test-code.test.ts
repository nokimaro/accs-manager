import { accounts, auditLog, desc, eq } from '@workspace/db'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { loginAs, send, setupApp, type TestApp } from './helpers.ts'

let ta: TestApp
let cookie: string
beforeAll(async () => {
  ta = await setupApp()
  cookie = (await loginAs(ta)).cookie
})
afterAll(async () => {
  await ta.close()
})

const TOKEN = 'gateway-test-token-123'
const device = { deviceModel: 'Desktop', systemVersion: 'Windows 11 x64', appVersion: '7.2.9 x64', langCode: 'ru' }
let user = 5000
const insertAccount = async (values: Partial<typeof accounts.$inferInsert> = {}) =>
  (await ta.t.db.insert(accounts).values({ tgUserId: user++, phone: '77001234567', source: 'tdata', clientProfile: 'desktop', device, connectionMode: 'direct', ...values }).returning())[0]!

/** Gateway as seen through fetch: answers by method, remembers what was asked */
let calls: { url: string; headers: Record<string, string>; body: Record<string, unknown> }[] = []
let answer: (method: string) => unknown
beforeEach(async () => {
  await ta.t.db.delete(accounts)
  calls = []
  ta.deps.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) })
    const res = answer(url.split('/').at(-1)!)
    if (res instanceof Error) throw res
    return new Response(JSON.stringify(res), { headers: { 'Content-Type': 'application/json' } })
  }) as typeof fetch
})

const status = (delivery: string) => ({
  ok: true,
  result: { request_id: '221873766087321', phone_number: '77001234567', request_cost: 0.01, remaining_balance: 95.79, delivery_status: { status: delivery, updated_at: 1 } },
})

describe('test code through Telegram Gateway', () => {
  it('needs the Gateway token', async () => {
    const a = await insertAccount()
    const res = await send(ta.app, `/api/accounts/${a.id}/test-code`, { cookie, method: 'POST' })
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ error: 'gateway_token_missing' })
    expect(calls).toEqual([])
  })

  it('sends a new code to the account’s number and follows its delivery; the token stays out of the audit log', async () => {
    await ta.deps.settings.update({ 'gateway.token': TOKEN }, { adminId: null })
    const a = await insertAccount()
    answer = () => status('sent')
    const res = await send(ta.app, `/api/accounts/${a.id}/test-code`, { cookie, method: 'POST' })
    expect(await res.json()).toEqual({ requestId: '221873766087321', delivery: 'sent', cost: 0.01, remainingBalance: 95.79 })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('https://gatewayapi.telegram.org/sendVerificationMessage')
    expect(calls[0]!.headers.Authorization).toBe(`Bearer ${TOKEN}`)
    // a fresh request every time: no request_id from checkSendAbility
    expect(calls[0]!.body).toEqual({ phone_number: '+77001234567', code_length: 6, ttl: 300 })
    const [audit] = await ta.t.db.select().from(auditLog).where(eq(auditLog.action, 'account.test_code')).orderBy(desc(auditLog.id)).limit(1)
    expect(audit).toMatchObject({ targetType: 'account', targetId: a.id, result: 'ok' })
    expect(JSON.stringify(audit)).not.toContain(TOKEN)

    answer = () => status('delivered')
    const delivered = await send(ta.app, `/api/accounts/${a.id}/test-code/221873766087321`, { cookie, method: 'GET' })
    expect(await delivered.json()).toMatchObject({ requestId: '221873766087321', delivery: 'delivered' })
    expect(calls[1]!.body).toEqual({ request_id: '221873766087321' })

    // a request that went to another number is not this account's
    const other = await insertAccount({ phone: '77009999999' })
    expect((await send(ta.app, `/api/accounts/${other.id}/test-code/221873766087321`, { cookie, method: 'GET' })).status).toBe(404)
    expect((await send(ta.app, `/api/accounts/${a.id}/test-code/not-a-number`, { cookie, method: 'GET' })).status).toBe(400)
  })

  it('says in words why Gateway refused', async () => {
    await ta.deps.settings.update({ 'gateway.token': TOKEN }, { adminId: null })
    const a = await insertAccount()
    const refuse = async (gateway: unknown, httpStatus: number, error: string, message?: RegExp) => {
      answer = () => gateway
      const res = await send(ta.app, `/api/accounts/${a.id}/test-code`, { cookie, method: 'POST' })
      expect(res.status).toBe(httpStatus)
      const body = (await res.json()) as { error: string; message: string }
      expect(body.error).toBe(error)
      if (message) expect(body.message).toMatch(message)
    }
    await refuse({ ok: false, error: 'PHONE_NUMBER_NOT_AVAILABLE' }, 409, 'gateway_not_available', /давно не был в сети/)
    await refuse({ ok: false, error: 'FLOOD_WAIT_3179' }, 409, 'gateway_flood', /через 53 мин/)
    await refuse({ ok: false, error: 'FLOOD_WAIT_59' }, 409, 'gateway_flood', /через 1 мин/)
    await refuse({ ok: false, error: 'ACCESS_TOKEN_INVALID' }, 409, 'gateway_token_invalid')
    await refuse({ ok: false, error: 'SOMETHING_NEW' }, 409, 'gateway_error', /SOMETHING_NEW/)
    await refuse(new TypeError('fetch failed'), 503, 'gateway_unreachable')
  })

  it('needs the account’s phone number', async () => {
    await ta.deps.settings.update({ 'gateway.token': TOKEN }, { adminId: null })
    const a = await insertAccount({ phone: null })
    const res = await send(ta.app, `/api/accounts/${a.id}/test-code`, { cookie, method: 'POST' })
    expect(await res.json()).toMatchObject({ error: 'no_phone' })
    expect(calls).toEqual([])
  })
})
