import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createAdmin, disableAdmin } from '../src/services/admins.ts'
import { loginAs, send, sessionCookie, setupApp, uniqueLogin, type TestApp } from './helpers.ts'

let ta: TestApp
beforeAll(async () => {
  ta = await setupApp()
})
afterAll(async () => {
  await ta.close()
})

describe('auth', () => {
  it('logs in with a hardened session cookie and serves /me', async () => {
    const login = uniqueLogin()
    await createAdmin(ta.deps.db, { login, password: 'correct horse battery' })
    const res = await send(ta.app, '/api/auth/login', { body: { login: login.toUpperCase(), password: 'correct horse battery' } })
    expect(res.status).toBe(200)
    const setCookie = res.headers.get('set-cookie') ?? ''
    expect(setCookie).toMatch(/HttpOnly/)
    expect(setCookie).toMatch(/SameSite=Strict/)
    expect(setCookie).toMatch(/Secure/)
    const me = await send(ta.app, '/api/auth/me', { cookie: sessionCookie(res) })
    expect(await me.json()).toMatchObject({ login })
  })

  it('omits Secure for an http PUBLIC_ORIGIN (local dev in Safari)', async () => {
    const dev = await setupApp({ PUBLIC_ORIGIN: 'http://localhost:5173' })
    try {
      const login = uniqueLogin()
      await createAdmin(dev.deps.db, { login, password: 'correct horse battery' })
      const res = await send(dev.app, '/api/auth/login', { body: { login, password: 'correct horse battery' }, origin: 'http://localhost:5173' })
      expect(res.status).toBe(200)
      expect(res.headers.get('set-cookie')).not.toMatch(/Secure/)
    } finally {
      await dev.close()
    }
  })

  it('rejects wrong password, unknown and disabled admins with the same 401', async () => {
    const a = await loginAs(ta)
    const b = await loginAs(ta)
    await disableAdmin(ta.deps.db, b.id)
    for (const body of [
      { login: a.login, password: 'wrong password!' },
      { login: 'nobody-here', password: 'whatever12345' },
      { login: b.login, password: 'correct horse battery' },
    ]) {
      const res = await send(ta.app, '/api/auth/login', { body, ip: '10.1.1.1' })
      expect(res.status).toBe(401)
      expect(await res.json()).toMatchObject({ error: 'invalid_credentials' })
    }
  })

  it('rate-limits login attempts per login with Retry-After', async () => {
    await ta.deps.settings.update({ 'security.loginMaxAttempts': 3 }, { adminId: null })
    const login = uniqueLogin()
    const statuses: number[] = []
    for (let i = 0; i < 4; i++) {
      const res = await send(ta.app, '/api/auth/login', { body: { login, password: 'bad password!' }, ip: `10.2.0.${i}` })
      statuses.push(res.status)
      if (res.status === 429) expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0)
    }
    expect(statuses).toEqual([401, 401, 401, 429])
    await ta.deps.settings.update({ 'security.loginMaxAttempts': null }, { adminId: null })
  })

  it('never rate-limits successful logins', async () => {
    await ta.deps.settings.update({ 'security.loginMaxAttempts': 3 }, { adminId: null })
    const login = uniqueLogin()
    await createAdmin(ta.deps.db, { login, password: 'correct horse battery' })
    for (let i = 0; i < 6; i++) {
      const res = await send(ta.app, '/api/auth/login', { body: { login, password: 'correct horse battery' }, ip: '10.6.6.6' })
      expect(res.status).toBe(200)
    }
    await ta.deps.settings.update({ 'security.loginMaxAttempts': null }, { adminId: null })
  })

  it('logout invalidates the session', async () => {
    const { cookie } = await loginAs(ta)
    expect((await send(ta.app, '/api/auth/logout', { method: 'POST', cookie })).status).toBe(204)
    expect((await send(ta.app, '/api/auth/me', { cookie })).status).toBe(401)
  })

  it('changes password: checks the current one and revokes sessions', async () => {
    const { cookie } = await loginAs(ta)
    const bad = await send(ta.app, '/api/auth/password', { cookie, body: { currentPassword: 'nope', newPassword: 'another long secret' } })
    expect(bad.status).toBe(400)
    expect(await bad.json()).toMatchObject({ fields: { currentPassword: expect.any(String) } })
    const ok = await send(ta.app, '/api/auth/password', { cookie, body: { currentPassword: 'correct horse battery', newPassword: 'another long secret' } })
    expect(ok.status).toBe(204)
    expect((await send(ta.app, '/api/auth/me', { cookie })).status).toBe(401)
  })

  it('blocks state-changing requests without the expected Origin', async () => {
    const { cookie } = await loginAs(ta)
    expect((await send(ta.app, '/api/auth/logout', { method: 'POST', cookie, origin: null })).status).toBe(403)
    expect((await send(ta.app, '/api/auth/logout', { method: 'POST', cookie, origin: 'https://evil.test' })).status).toBe(403)
    expect((await send(ta.app, '/api/auth/me', { cookie, origin: null })).status).toBe(200)
  })

  it('does not let a parallel burst bypass the limit', async () => {
    await ta.deps.settings.update({ 'security.loginMaxAttempts': 3 }, { adminId: null })
    try {
      const login = uniqueLogin()
      const statuses = await Promise.all(
        Array.from({ length: 6 }, (_, i) =>
          send(ta.app, '/api/auth/login', { body: { login, password: 'bad password!' }, ip: `10.7.0.${i}` }).then((r) => r.status),
        ),
      )
      expect(statuses.filter((s) => s === 401)).toHaveLength(3)
      expect(statuses.filter((s) => s === 429)).toHaveLength(3)
    } finally {
      await ta.deps.settings.update({ 'security.loginMaxAttempts': null }, { adminId: null })
    }
  })

  it('throttles current-password guesses on /auth/password', async () => {
    await ta.deps.settings.update({ 'security.loginMaxAttempts': 3 }, { adminId: null })
    try {
      const { cookie } = await loginAs(ta)
      const statuses: number[] = []
      for (let i = 0; i < 4; i++) {
        const res = await send(ta.app, '/api/auth/password', { cookie, body: { currentPassword: 'wrong guess', newPassword: 'another long secret' } })
        statuses.push(res.status)
      }
      expect(statuses).toEqual([400, 400, 400, 429])
    } finally {
      await ta.deps.settings.update({ 'security.loginMaxAttempts': null }, { adminId: null })
    }
  })

  it('does not touch the per-login counter once the IP is over its limit', async () => {
    await ta.deps.settings.update({ 'security.loginMaxAttempts': 3 }, { adminId: null })
    try {
      const ip = '10.11.0.1'
      for (let i = 0; i < 3; i++) {
        await send(ta.app, '/api/auth/login', { body: { login: uniqueLogin(), password: 'bad password!' }, ip })
      }
      const victim = uniqueLogin()
      const res = await send(ta.app, '/api/auth/login', { body: { login: victim, password: 'bad password!' }, ip })
      expect(res.status).toBe(429)
      expect(await ta.deps.redis.get(`rl:login:user:${victim}`)).toBeNull()
    } finally {
      await ta.deps.settings.update({ 'security.loginMaxAttempts': null }, { adminId: null })
    }
  })

  it('rejects control characters in the login with 400, never 500', async () => {
    for (const login of ['a\u0000b', 'a\nb']) {
      const res = await send(ta.app, '/api/auth/login', { body: { login, password: 'whatever12345' }, ip: '10.11.0.2' })
      expect(res.status).toBe(400)
      expect(await res.json()).toMatchObject({ error: 'validation', fields: { login: expect.any(String) } })
    }
  })
})
