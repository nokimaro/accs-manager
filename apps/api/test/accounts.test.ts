import { accounts, auditLog, codeMessages, desc, eq, proxies } from '@workspace/db'
import type { AccountDto } from '@workspace/shared/accounts'
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
  await ta.t.db.delete(proxies)
  ta.commands.sent = []
  ta.commands.respond = () => null
})

const device = { deviceModel: 'Desktop', systemVersion: 'Windows 11 x64', appVersion: '7.2.9 x64', langCode: 'ru' }
let user = 100
const insertAccount = async (values: Partial<typeof accounts.$inferInsert> = {}) =>
  (await ta.t.db.insert(accounts).values({ tgUserId: user++, source: 'tdata', clientProfile: 'desktop', device, connectionMode: 'direct', ...values }).returning())[0]!
let host = 1
const insertProxy = async (values: Partial<typeof proxies.$inferInsert> = {}) =>
  (await ta.t.db.insert(proxies).values({ source: 'manual', type: 'socks5', host: `10.5.5.${host++}`, port: 1080, status: 'ok', tgCountry: 'KZ', ...values }).returning())[0]!
const json = async <T,>(res: Response) => (await res.json()) as T

describe('accounts api', () => {
  it('lists accounts with their proxy and the time of the last code', async () => {
    const p = await insertProxy()
    const a = await insertAccount({ connectionMode: 'proxy', proxyId: p.id, phone: '77001234567', status: 'active' })
    await ta.t.db.insert(codeMessages).values({ accountId: a.id, tgMessageId: 1, date: new Date('2026-10-03T10:00:00Z'), text: 't', code: '1' })
    const { items } = await json<{ items: AccountDto[] }>(await send(ta.app, '/api/accounts', { cookie }))
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ id: a.id, phone: '77001234567', status: 'active', proxy: { id: p.id, host: p.host, status: 'ok', tgCountry: 'KZ' }, lastCodeAt: '2026-10-03T10:00:00.000Z', device })
    expect((await send(ta.app, `/api/accounts/${a.id}`, { cookie })).status).toBe(200)
  })

  it('edits the label and note', async () => {
    const a = await insertAccount()
    const updated = await json<AccountDto>(await send(ta.app, `/api/accounts/${a.id}`, { cookie, method: 'PATCH', body: { label: 'Основной', note: '' } }))
    expect(updated).toMatchObject({ label: 'Основной', note: null })
  })

  it('moves an account to a free proxy or to direct, and refuses busy or broken proxies', async () => {
    const a = await insertAccount({ status: 'proxy_down', connectionMode: 'proxy' })
    const free = await insertProxy()
    const busy = await insertProxy()
    await insertAccount({ connectionMode: 'proxy', proxyId: busy.id })
    const dead = await insertProxy({ status: 'dead' })

    for (const proxyId of [busy.id, dead.id]) {
      const res = await send(ta.app, `/api/accounts/${a.id}/proxy`, { cookie, method: 'PUT', body: { proxyId } })
      expect(res.status).toBe(409)
    }
    const moved = await json<AccountDto>(await send(ta.app, `/api/accounts/${a.id}/proxy`, { cookie, method: 'PUT', body: { proxyId: free.id } }))
    expect(moved).toMatchObject({ connectionMode: 'proxy', proxy: { id: free.id }, status: 'pending_check' })
    expect(ta.commands.sent).toEqual([{ type: 'account.sync', accountId: a.id }])
    const direct = await json<AccountDto>(await send(ta.app, `/api/accounts/${a.id}/proxy`, { cookie, method: 'PUT', body: { proxyId: null } }))
    expect(direct).toMatchObject({ connectionMode: 'direct', proxy: null })
  })

  it('pauses and resumes through the worker', async () => {
    const a = await insertAccount({ status: 'active' })
    expect(await json<AccountDto>(await send(ta.app, `/api/accounts/${a.id}/pause`, { cookie, method: 'POST' }))).toMatchObject({ status: 'paused' })
    expect(await json<AccountDto>(await send(ta.app, `/api/accounts/${a.id}/resume`, { cookie, method: 'POST' }))).toMatchObject({ status: 'pending_check' })
    expect(ta.commands.sent).toEqual([
      { type: 'account.stop', accountId: a.id, logout: false },
      { type: 'account.sync', accountId: a.id },
    ])
    const revoked = await insertAccount({ status: 'unauthorized' })
    expect((await send(ta.app, `/api/accounts/${revoked.id}/pause`, { cookie, method: 'POST' })).status).toBe(409)
  })

  it('deletes after the worker let go; with logout only when it really logged out', async () => {
    const a = await insertAccount()
    await ta.t.db.insert(codeMessages).values({ accountId: a.id, tgMessageId: 1, date: new Date(), text: 't' })
    ta.commands.respond = () => ({ stopped: false, loggedOut: false })
    const refused = await send(ta.app, `/api/accounts/${a.id}?logout=true`, { cookie, method: 'DELETE' })
    expect(refused.status).toBe(409)
    expect(await json(refused)).toMatchObject({ error: 'logout_failed' })
    expect(await ta.t.db.select().from(accounts).where(eq(accounts.id, a.id))).toHaveLength(1)

    expect((await send(ta.app, `/api/accounts/${a.id}`, { cookie, method: 'DELETE' })).status).toBe(204)
    expect(await ta.t.db.select().from(accounts).where(eq(accounts.id, a.id))).toEqual([])
    expect(await ta.t.db.select().from(codeMessages).where(eq(codeMessages.accountId, a.id))).toEqual([])
    expect(ta.commands.sent.at(-1)).toEqual({ type: 'account.stop', accountId: a.id, logout: false })
  })

  it('lists and ends active sessions only while the account is connected', async () => {
    const a = await insertAccount({ status: 'active' })
    const session = { hash: '-123', current: false, official: true, appName: 'Telegram Desktop', appVersion: '7.2.9 x64', deviceModel: 'Desktop', platform: 'Windows', systemVersion: 'Windows 11 x64', ip: '1.2.3.4', country: 'Kazakhstan', region: '', createdAt: '2026-10-01T00:00:00.000Z', activeAt: '2026-10-03T00:00:00.000Z' }
    ta.commands.respond = (c: WorkerCommand) => (c.type === 'account.sessions' ? { sessions: [session] } : { ok: true })
    expect(await json(await send(ta.app, `/api/accounts/${a.id}/sessions`, { cookie }))).toEqual({ items: [session] })
    expect((await send(ta.app, `/api/accounts/${a.id}/sessions/-123`, { cookie, method: 'DELETE' })).status).toBe(204)
    expect((await send(ta.app, `/api/accounts/${a.id}/sessions/abc`, { cookie, method: 'DELETE' })).status).toBe(400)
    const [read] = await ta.t.db.select().from(auditLog).where(eq(auditLog.action, 'account.sessions.read')).orderBy(desc(auditLog.id)).limit(1)
    expect(read).toMatchObject({ targetId: a.id, result: 'ok' })

    ta.commands.respond = () => ({ error: 'not_running' })
    const offline = await send(ta.app, `/api/accounts/${a.id}/sessions`, { cookie })
    expect(offline.status).toBe(409)
    expect(await json(offline)).toMatchObject({ error: 'not_running' })
  })
})
