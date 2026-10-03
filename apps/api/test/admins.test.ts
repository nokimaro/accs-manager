import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { loginAs, send, setupApp, uniqueLogin, type TestApp } from './helpers.ts'

let ta: TestApp
beforeAll(async () => {
  ta = await setupApp()
})
afterAll(async () => {
  await ta.close()
})

describe('admins', () => {
  it('creates, lists and rejects duplicates and bad input', async () => {
    const { cookie } = await loginAs(ta)
    const login = uniqueLogin()
    const created = await send(ta.app, '/api/admins', { cookie, body: { login, password: 'long enough password' } })
    expect(created.status).toBe(201)
    expect(await created.json()).not.toHaveProperty('passwordHash')
    expect((await send(ta.app, '/api/admins', { cookie, body: { login, password: 'long enough password' } })).status).toBe(409)
    const bad = await send(ta.app, '/api/admins', { cookie, body: { login: 'A B', password: 'short' } })
    expect(bad.status).toBe(400)
    expect(Object.keys(((await bad.json()) as { fields: object }).fields).sort()).toEqual(['login', 'password'])
    const list = (await (await send(ta.app, '/api/admins', { cookie })).json()) as { items: { login: string }[] }
    expect(list.items.map((a) => a.login)).toContain(login)
  })

  it('disabling an admin revokes their live sessions', async () => {
    const me = await loginAs(ta)
    const other = await loginAs(ta)
    expect((await send(ta.app, '/api/auth/me', { cookie: other.cookie })).status).toBe(200)
    const res = await send(ta.app, `/api/admins/${other.id}/disable`, { method: 'POST', cookie: me.cookie })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ disabledAt: expect.any(String) })
    expect((await send(ta.app, '/api/auth/me', { cookie: other.cookie })).status).toBe(401)
  })

  it('refuses to disable the last active admin', async () => {
    const solo = await setupApp()
    try {
      const me = await loginAs(solo)
      const res = await send(solo.app, `/api/admins/${me.id}/disable`, { method: 'POST', cookie: me.cookie })
      expect(res.status).toBe(409)
      expect(await res.json()).toMatchObject({ error: 'last_admin' })
    } finally {
      await solo.close()
    }
  })

  it('reset-password revokes the target sessions', async () => {
    const me = await loginAs(ta)
    const other = await loginAs(ta)
    const res = await send(ta.app, `/api/admins/${other.id}/reset-password`, { cookie: me.cookie, body: { password: 'brand new password' } })
    expect(res.status).toBe(204)
    expect((await send(ta.app, '/api/auth/me', { cookie: other.cookie })).status).toBe(401)
  })

  it('returns 404 for unknown and 400 for malformed ids', async () => {
    const { cookie } = await loginAs(ta)
    expect((await send(ta.app, '/api/admins/00000000-0000-4000-8000-000000000000/disable', { method: 'POST', cookie })).status).toBe(404)
    expect((await send(ta.app, '/api/admins/not-a-uuid/disable', { method: 'POST', cookie })).status).toBe(400)
  })
})
