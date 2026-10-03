import { auditLog, desc, eq } from '@workspace/db'
import { createRedis } from '@workspace/server'
import { qrControlChannel } from '@workspace/shared/commands'
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest'
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

describe('QR login api', () => {
  it('needs the own api_id before starting', async () => {
    const res = await send(ta.app, '/api/qr', { cookie, body: { proxyId: null } })
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ error: 'own_api_missing' })
  })

  it('starts a login on the worker, forwards the 2FA password and the cancel over pub/sub', async () => {
    await ta.deps.settings.update({ 'telegram.own.apiId': 123456, 'telegram.own.apiHash': '0123456789abcdef0123456789abcdef' }, { adminId: null })
    ta.commands.sent = []
    const { qrId } = (await (await send(ta.app, '/api/qr', { cookie, body: { proxyId: null } })).json()) as { qrId: string }
    expect(ta.commands.sent).toEqual([{ type: 'qr.start', qrId, proxyId: null, adminId: expect.any(String) }])

    const sub = createRedis(inject('redisUrl'), 'qr-test-sub')
    const received: string[] = []
    try {
      await sub.subscribe(qrControlChannel(qrId))
      sub.on('message', (_c: string, m: string) => received.push(m))
      expect((await send(ta.app, `/api/qr/${qrId}/password`, { cookie, body: { password: 'my-2fa-pass' } })).status).toBe(202)
      expect((await send(ta.app, `/api/qr/${qrId}`, { cookie, method: 'DELETE' })).status).toBe(204)
      await vi.waitFor(() => expect(received.map((m) => JSON.parse(m))).toEqual([{ type: 'password', password: 'my-2fa-pass' }, { type: 'cancel' }]))
    } finally {
      await sub.quit()
    }
    const [audit] = await ta.t.db.select().from(auditLog).where(eq(auditLog.action, 'account.qr.password')).orderBy(desc(auditLog.id)).limit(1)
    expect(audit).toMatchObject({ targetId: qrId, payload: null })
  })
})
