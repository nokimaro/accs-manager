import { auditLog } from '@workspace/db'
import { desc, eq } from '@workspace/db'
import { Hono } from 'hono'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { AppDeps, AppEnv, SessionAdmin } from '../src/deps.ts'
import { audited, auditTrail } from '../src/middleware/audit.ts'
import { createAdmin } from '../src/services/admins.ts'
import { loginAs, send, setupApp, uniqueLogin, type TestApp } from './helpers.ts'

let ta: TestApp
/** the probe routes act as this signed-in admin: bodies of anonymous requests are not stored */
let probeAdmin: SessionAdmin
beforeAll(async () => {
  ta = await setupApp()
  const { id, login } = await createAdmin(ta.deps.db, { login: uniqueLogin('probe'), password: 'correct horse battery' })
  probeAdmin = { id, login }
})
afterAll(async () => {
  await ta.close()
})

const lastAudit = async () => (await ta.t.db.select().from(auditLog).orderBy(desc(auditLog.id)).limit(1))[0]

/** A tiny app that uses the real auditTrail middleware with routes that misbehave. */
function probeApp(deps: AppDeps = ta.deps) {
  const app = new Hono<AppEnv>()
  app.use('*', async (c, next) => {
    c.set('deps', deps)
    c.set('clientIp', '10.5.5.5')
    c.set('admin', probeAdmin)
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

  it('audits an admin action whose body carries a NUL (Postgres jsonb would reject it)', async () => {
    const { cookie } = await loginAs(ta)
    const login = uniqueLogin()
    const res = await send(ta.app, '/api/admins', { cookie, body: { login, password: 'long enough password', z: '\u0000' } })
    expect(res.status).toBe(201)
    const { id } = (await res.json()) as { id: string }
    const [row] = await ta.t.db.select().from(auditLog).where(eq(auditLog.targetId, id))
    expect(row).toMatchObject({ action: 'admin.create', result: 'ok', payload: { login, password: '[redacted]', z: '' } })
  })

  it('keeps the truncated preview well-formed when the cut splits a surrogate pair', async () => {
    // JSON text: {"items":[" (11 chars) + emoji pairs, so the 2000-char preview ends inside a pair
    await probeApp().request('/echo', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ items: Array.from({ length: 10 }, () => '😀'.repeat(1000)) }),
    })
    const row = await lastAudit()
    expect(row).toMatchObject({ action: 'POST /echo', payload: { truncated: true } })
    expect((row?.payload as { preview: string }).preview.isWellFormed()).toBe(true)
  })

  it('still records the action when the audit insert fails, without the payload', async () => {
    let failures = 1
    const flakyDb = new Proxy(ta.t.db, {
      get(target, prop, receiver) {
        if (prop === 'insert' && failures > 0) {
          failures--
          return () => {
            throw new Error('insert failed')
          }
        }
        return Reflect.get(target, prop, receiver)
      },
    })
    const res = await probeApp({ ...ta.deps, db: flakyDb }).request('/echo', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"a":1}' })
    expect(res.status).toBe(200)
    expect(await lastAudit()).toMatchObject({ action: 'POST /echo', result: 'ok', ip: '10.5.5.5', payload: { unrecordable: true } })

    // both attempts failing never breaks the response
    failures = 2
    const before = (await lastAudit())?.id
    expect((await probeApp({ ...ta.deps, db: flakyDb }).request('/echo', { method: 'POST' })).status).toBe(200)
    expect((await lastAudit())?.id).toBe(before)
  })

  it('stores no body for anonymous mutating requests, but keeps the login route payload', async () => {
    const ip = '10.12.0.1'
    await send(ta.app, '/api/admins', { body: { login: 'x', password: 'y', junk: 'z'.repeat(1000) }, ip })
    await send(ta.app, '/api/auth/login', { body: { login: 'ghost2', password: 'secret-pass-123' }, ip })
    const rows = await ta.t.db.select().from(auditLog).where(eq(auditLog.ip, ip)).orderBy(auditLog.id)
    expect(rows.map((r) => [r.statusCode, r.adminId, r.payload])).toEqual([
      [401, null, null],
      [401, null, { login: 'ghost2' }],
    ])
  })
})
