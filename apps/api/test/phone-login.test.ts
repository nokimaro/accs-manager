import { accounts, auditLog, proxies } from '@workspace/db'
import { createRedis } from '@workspace/server'
import { loginControlChannel } from '@workspace/shared/commands'
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

describe('phone login api', () => {
  it('needs the own api_id, a real phone number and a working proxy', async () => {
    const start = (body: unknown) => send(ta.app, '/api/phone-login', { cookie, body })
    const noApi = await start({ phone: '+7 700 123 45 67', proxyId: null })
    expect(noApi.status).toBe(409)
    expect(await noApi.json()).toMatchObject({ error: 'own_api_missing' })

    await ta.deps.settings.update({ 'telegram.own.apiId': 123456, 'telegram.own.apiHash': '0123456789abcdef0123456789abcdef' }, { adminId: null })
    expect((await start({ phone: 'call me', proxyId: null })).status).toBe(400)
    const [dead] = await ta.t.db.insert(proxies).values({ source: 'manual', type: 'socks5', host: '10.5.5.1', port: 1080, status: 'dead' }).returning()
    const broken = await start({ phone: '+77001234567', proxyId: dead!.id })
    expect(broken.status).toBe(409)
    expect(await broken.json()).toMatchObject({ error: 'proxy_unavailable' })
  })

  it('starts a login on the worker and passes code, password, resend and cancel over pub/sub — never into the audit log', async () => {
    await ta.deps.settings.update({ 'telegram.own.apiId': 123456, 'telegram.own.apiHash': '0123456789abcdef0123456789abcdef' }, { adminId: null })
    ta.commands.sent = []
    const res = await send(ta.app, '/api/phone-login', { cookie, body: { phone: '+7 (700) 123-45-67', proxyId: null } })
    expect(res.status).toBe(201)
    const { loginId } = (await res.json()) as { loginId: string }
    expect(ta.commands.sent).toEqual([{ type: 'phone.start', loginId, phone: '77001234567', proxyId: null, adminId: expect.any(String) }])

    const sub = createRedis(inject('redisUrl'), 'phone-test-sub')
    const received: unknown[] = []
    try {
      await sub.subscribe(loginControlChannel(loginId))
      sub.on('message', (_c: string, m: string) => received.push(JSON.parse(m)))
      expect((await send(ta.app, `/api/phone-login/${loginId}/code`, { cookie, body: { code: '58 093' } })).status).toBe(202)
      expect((await send(ta.app, `/api/phone-login/${loginId}/resend`, { cookie, body: {} })).status).toBe(202)
      expect((await send(ta.app, `/api/phone-login/${loginId}/password`, { cookie, body: { password: 's3cret-cloud' } })).status).toBe(202)
      expect((await send(ta.app, `/api/phone-login/${loginId}`, { cookie, method: 'DELETE' })).status).toBe(204)
      expect((await send(ta.app, `/api/phone-login/${loginId}/code`, { cookie, body: { code: 'abc' } })).status).toBe(400)
      await vi.waitFor(() =>
        expect(received).toEqual([{ type: 'code', code: '58093' }, { type: 'resend' }, { type: 'password', password: 's3cret-cloud' }, { type: 'cancel' }]),
      )
    } finally {
      await sub.quit()
    }
    const audit = JSON.stringify(await ta.t.db.select().from(auditLog))
    expect(audit).not.toContain('s3cret-cloud')
    expect(audit).not.toContain('58093')
    expect(await ta.t.db.select().from(accounts)).toHaveLength(0)
  })
})
