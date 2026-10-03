import { auditLog } from '@workspace/db'
import { desc, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { AppEnv } from '../src/deps.ts'
import { audited, auditTrail } from '../src/middleware/audit.ts'
import { createAdmin } from '../src/services/admins.ts'
import { loginAs, send, setupApp, uniqueLogin, type TestApp } from './helpers.ts'

let ta: TestApp
beforeAll(async () => {
  ta = await setupApp()
})
afterAll(async () => {
  await ta.close()
})

const lastAudit = async () => (await ta.t.db.select().from(auditLog).orderBy(desc(auditLog.id)).limit(1))[0]

/** A tiny app that uses the real auditTrail middleware with routes that misbehave. */
function probeApp() {
  const app = new Hono<AppEnv>()
  app.use('*', async (c, next) => {
    c.set('deps', ta.deps)
    c.set('clientIp', '10.5.5.5')
    c.set('admin', null)
    c.set('sessionId', null)
    await next()
  })
  app.use('*', auditTrail)
  app.get('/plain', (c) => c.json({ ok: true }))
  app.get('/secret-read', audited('probe.read'), (c) => c.json({ ok: true }))
  app.post('/boom', () => {
    throw new Error('kaboom')
  })
  app.post('/echo', (c) => c.json({ ok: true }))
  app.post('/no-body', audited('probe.nobody', { payload: null }), (c) => c.json({ ok: true }))
  app.onError((_err, c) => c.json({ error: 'internal' }, 500))
  return app
}

describe('audit trail', () => {
  it('records successful and failed logins without the password', async () => {
    const { id, login } = await loginAs(ta)
    let row = (await ta.t.db.select().from(auditLog).where(eq(auditLog.adminId, id)).orderBy(desc(auditLog.id)).limit(1))[0]
    expect(row).toMatchObject({ action: 'auth.login', actorType: 'admin', result: 'ok', statusCode: 200, payload: { login } })

    await send(ta.app, '/api/auth/login', { body: { login: 'ghost', password: 'secret-pass-123' }, ip: '10.4.4.4' })
    row = await lastAudit()
    expect(row).toMatchObject({ action: 'auth.login', adminId: null, result: 'error', statusCode: 401, payload: { login: 'ghost' } })
    expect(JSON.stringify(row?.payload)).not.toContain('secret-pass-123')
  })

  it('still records a request whose handler threw', async () => {
    await probeApp().request('/boom', { method: 'POST' })
    expect(await lastAudit()).toMatchObject({ action: 'POST /boom', result: 'error', statusCode: 500 })
  })

  it('redacts uploaded files and secret fields in multipart bodies', async () => {
    const form = new FormData()
    form.set('note', 'hello')
    form.set('passcode', '1234')
    form.set('archive', new File(['zip-bytes'], 'tdata.zip'))
    await probeApp().request('/echo', { method: 'POST', body: form })
    expect((await lastAudit())?.payload).toEqual({ note: 'hello', passcode: '[redacted]', archive: '[redacted:file]' })
  })

  it('truncates oversized payloads', async () => {
    await probeApp().request('/echo', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ items: Array.from({ length: 500 }, (_, i) => `item-${i}-${'x'.repeat(40)}`) }),
    })
    expect((await lastAudit())?.payload).toMatchObject({ truncated: true, preview: expect.any(String) })
  })

  it('lists entries with admin login and filters by action', async () => {
    const leaving = await loginAs(ta)
    const reader = await loginAs(ta)
    await send(ta.app, '/api/auth/logout', { method: 'POST', cookie: leaving.cookie })
    const res = await send(ta.app, '/api/audit?action=auth.logout&pageSize=10', { cookie: reader.cookie })
    expect(res.status).toBe(200)
    const page = (await res.json()) as { items: { action: string; adminLogin: string | null }[]; total: number }
    expect(page.total).toBeGreaterThanOrEqual(1)
    expect(page.items.every((i) => i.action === 'auth.logout')).toBe(true)
    expect(page.items.map((i) => i.adminLogin)).toContain(leaving.login)
  })

  it('uses the socket address unless TRUST_PROXY is on', async () => {
    const login = uniqueLogin()
    await createAdmin(ta.deps.db, { login, password: 'correct horse battery' })
    await send(ta.app, '/api/auth/login', { body: { login, password: 'x-wrong-x' }, ip: '10.3.3.3', headers: { 'x-forwarded-for': '6.6.6.6' } })
    const [row] = await ta.t.db.select().from(auditLog).where(eq(auditLog.action, 'auth.login')).orderBy(desc(auditLog.id)).limit(1)
    expect(row?.ip).toBe('10.3.3.3')

    const proxied = await setupApp({ TRUST_PROXY: 'true' })
    try {
      await send(proxied.app, '/api/auth/login', { body: { login, password: 'x-wrong-x' }, ip: '10.3.3.3', headers: { 'x-forwarded-for': '6.6.6.6, 7.7.7.7' } })
      const [r2] = await proxied.t.db.select().from(auditLog).orderBy(desc(auditLog.id)).limit(1)
      expect(r2?.ip).toBe('7.7.7.7')
    } finally {
      await proxied.close()
    }
  })

  it('requires auth for the audit list', async () => {
    expect((await send(ta.app, '/api/audit')).status).toBe(401)
  })

  it('redacts secrets before truncating oversized payloads', async () => {
    await probeApp().request('/echo', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'hunter2-secret', items: Array.from({ length: 500 }, (_, i) => `item-${i}-${'x'.repeat(40)}`) }),
    })
    const payload = (await lastAudit())?.payload
    expect(payload).toMatchObject({ truncated: true })
    expect(JSON.stringify(payload)).not.toContain('hunter2-secret')
  })

  it('does not buffer bodies larger than 64 KB', async () => {
    const big = JSON.stringify({ blob: 'x'.repeat(70_000) })
    await probeApp().request('/echo', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': String(big.length) },
      body: big,
    })
    expect((await lastAudit())?.payload).toEqual({ omitted: true, contentLength: big.length })
  })

  it('audits GETs marked with audited() and skips plain GETs', async () => {
    const before = (await lastAudit())?.id
    await probeApp().request('/plain')
    expect((await lastAudit())?.id).toBe(before)
    await probeApp().request('/secret-read')
    expect(await lastAudit()).toMatchObject({ action: 'probe.read', result: 'ok' })
  })

  it('never reads the body when audited() opts out with payload: null', async () => {
    await probeApp().request('/no-body', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'x' }) })
    expect(await lastAudit()).toMatchObject({ action: 'probe.nobody', payload: null })
  })
})
