import { accounts, auditLog, desc, eq } from '@workspace/db'
import type { WorkerCommand } from '@workspace/shared/commands'
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
beforeEach(async () => {
  await ta.t.db.delete(accounts)
  ta.commands.sent = []
  ta.commands.respond = () => null
})

const device = { deviceModel: 'Desktop', systemVersion: 'Windows 11 x64', appVersion: '7.2.9 x64', langCode: 'ru' }
let user = 300
const insertAccount = async (values: Partial<typeof accounts.$inferInsert> = {}) =>
  (await ta.t.db.insert(accounts).values({ tgUserId: user++, source: 'tdata', clientProfile: 'desktop', device, connectionMode: 'direct', status: 'active', ...values }).returning())[0]!
const json = async <T,>(res: Response) => (await res.json()) as T
const lastAudit = async (action: string) => (await ta.t.db.select().from(auditLog).where(eq(auditLog.action, action)).orderBy(desc(auditLog.id)).limit(1))[0]

describe('cloud password api', () => {
  it('passes the state through from the worker', async () => {
    const a = await insertAccount()
    const info = { hasPassword: true, hint: 'кот', known: false, hasRecovery: true, recoveryEmail: null, unconfirmedEmailPattern: null, pendingResetAt: null }
    ta.commands.respond = (c: WorkerCommand) => (c.type === 'account.password.info' ? { info } : null)
    expect(await json(await send(ta.app, `/api/accounts/${a.id}/cloud-password/info`, { cookie }))).toEqual(info)
    expect(ta.commands.sent).toEqual([{ type: 'account.password.info', accountId: a.id }])

    ta.commands.respond = () => ({ error: 'not_running' })
    const offline = await send(ta.app, `/api/accounts/${a.id}/cloud-password/info`, { cookie })
    expect(offline.status).toBe(409)
    expect(await json(offline)).toMatchObject({ error: 'not_running', message: 'Аккаунт сейчас не подключён к Telegram' })
  })

  it('shows the stored password on request and writes that into the audit log', async () => {
    const a = await insertAccount({ cloudPasswordEnc: ta.deps.cipher.encrypt('kn0wn-pass') })
    const res = await send(ta.app, `/api/accounts/${a.id}/cloud-password`, { cookie })
    expect(await json(res)).toEqual({ password: 'kn0wn-pass' })
    expect(await lastAudit('account.cloud_password.read')).toMatchObject({ targetId: a.id, result: 'ok' })
    expect(JSON.stringify(await ta.t.db.select().from(auditLog))).not.toContain('kn0wn-pass')

    const b = await insertAccount()
    const unknown = await send(ta.app, `/api/accounts/${b.id}/cloud-password`, { cookie })
    expect(unknown.status).toBe(404)
    expect(await json(unknown)).toMatchObject({ error: 'password_unknown' })
  })

  it('sends passwords and codes to the worker only encrypted, and never into the audit log', async () => {
    const a = await insertAccount()
    ta.commands.respond = (c: WorkerCommand) => (c.type === 'account.password.set' ? { emailCodeNeeded: { pattern: 'm***@example.com', length: 6 } } : { ok: true })
    const set = await send(ta.app, `/api/accounts/${a.id}/cloud-password`, {
      cookie,
      method: 'PUT',
      body: { currentPassword: 'old-s3cret', newPassword: 'new-s3cret', hint: 'кот', email: 'me@example.com' },
    })
    expect(await json(set)).toEqual({ emailCodeNeeded: { pattern: 'm***@example.com', length: 6 } })
    expect((await send(ta.app, `/api/accounts/${a.id}/cloud-password/verify`, { cookie, body: { password: 'cur-s3cret' } })).status).toBe(204)
    expect((await send(ta.app, `/api/accounts/${a.id}/cloud-password/email`, { cookie, body: { action: 'confirm', code: '424 242' } })).status).toBe(204)
    expect((await send(ta.app, `/api/accounts/${a.id}/cloud-password/email`, { cookie, body: { action: 'cancel' } })).status).toBe(204)

    const [setCmd, verifyCmd, confirmCmd, cancelCmd] = ta.commands.sent as Extract<WorkerCommand, { accountId: string }>[]
    expect(setCmd).toMatchObject({ type: 'account.password.set', accountId: a.id, hint: 'кот', email: 'me@example.com' })
    const decrypt = (v: unknown) => ta.deps.cipher.decrypt(String(v))
    if (setCmd?.type !== 'account.password.set' || verifyCmd?.type !== 'account.password.verify' || confirmCmd?.type !== 'account.password.email') throw new Error('unexpected commands')
    expect([decrypt(setCmd.currentPasswordEnc), decrypt(setCmd.newPasswordEnc), decrypt(verifyCmd.passwordEnc), decrypt(confirmCmd.codeEnc)]).toEqual([
      'old-s3cret',
      'new-s3cret',
      'cur-s3cret',
      '424242',
    ])
    expect(cancelCmd).toEqual({ type: 'account.password.email', accountId: a.id, action: 'cancel', codeEnc: null })
    for (const secret of ['old-s3cret', 'new-s3cret', 'cur-s3cret', '424242']) {
      expect(JSON.stringify(ta.commands.sent)).not.toContain(secret)
      expect(JSON.stringify(await ta.t.db.select().from(auditLog))).not.toContain(secret)
    }
    expect(await lastAudit('account.cloud_password.set')).toMatchObject({ targetId: a.id, payload: null })
  })

  it('turns what the worker refused into words', async () => {
    const a = await insertAccount()
    const put = (respond: unknown) => {
      ta.commands.respond = () => respond
      return send(ta.app, `/api/accounts/${a.id}/cloud-password`, { cookie, method: 'PUT', body: { newPassword: 'n' } })
    }
    const cases: [unknown, number, string, string][] = [
      [{ error: 'wrong_password' }, 422, 'wrong_password', 'Неверный текущий пароль'],
      [{ error: 'stale_password' }, 409, 'stale_password', 'Сохранённый пароль не подошёл — его сменили вне панели. Укажите текущий'],
      [{ error: 'password_unknown' }, 409, 'password_unknown', 'Панель не знает текущий пароль — введите его'],
      [{ error: 'too_fresh', retryAfterSec: 80_000 }, 409, 'too_fresh', 'Telegram пока не даёт менять пароль с этой сессии — подождите 23 ч'],
      [{ error: 'email_invalid' }, 422, 'email_invalid', 'Неверная почта'],
      [{ error: 'other', message: '400 PASSWORD_HINT_INVALID' }, 503, 'telegram_error', 'Telegram отказал: 400 PASSWORD_HINT_INVALID'],
    ]
    for (const [respond, status, error, message] of cases) {
      const res = await put(respond)
      expect([res.status, await json(res)]).toEqual([status, expect.objectContaining({ error, message })])
    }
    ta.commands.respond = () => ({ error: 'code_invalid' })
    const code = await send(ta.app, `/api/accounts/${a.id}/cloud-password/email`, { cookie, body: { action: 'confirm', code: '1' } })
    expect(code.status).toBe(400)
    const wrong = await send(ta.app, `/api/accounts/${a.id}/cloud-password/email`, { cookie, body: { action: 'confirm', code: '123456' } })
    expect([wrong.status, await json(wrong)]).toEqual([422, expect.objectContaining({ error: 'code_invalid', message: 'Неверный код' })])
  })

  it('404 for an unknown account', async () => {
    const res = await send(ta.app, '/api/accounts/00000000-0000-4000-8000-000000000999/cloud-password/info', { cookie })
    expect(res.status).toBe(404)
  })
})
