import { accounts, auditLog, desc, eq, proxies } from '@workspace/db'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { AccountNotRunningError, createAccountManager } from '../src/accounts/manager.ts'
import { fakeFactory, rpcError } from './fake-session.ts'
import { setupWorker, type TestWorker } from './helpers.ts'

let w: TestWorker
beforeAll(async () => {
  w = await setupWorker()
})
afterAll(async () => {
  await w.close()
})
beforeEach(async () => {
  await w.t.db.delete(accounts)
  await w.t.db.delete(proxies)
})

const device = { deviceModel: 'Desktop', systemVersion: 'Windows 11 x64', appVersion: '7.2.9 x64', langCode: 'ru' }
let nextUser = 1000
async function account(values: Partial<typeof accounts.$inferInsert> = {}) {
  const [row] = await w.t.db
    .insert(accounts)
    .values({ tgUserId: nextUser++, source: 'tdata', clientProfile: 'desktop', device, connectionMode: 'direct', ...values })
    .returning()
  return row!
}
async function proxy(values: Partial<typeof proxies.$inferInsert> = {}) {
  const [row] = await w.t.db
    .insert(proxies)
    .values({ source: 'manual', type: 'socks5', host: `10.7.7.${nextUser % 250}`, port: 1080, status: 'ok', username: 'u', passwordEnc: w.deps.cipher.encrypt('pw'), ...values })
    .returning()
  return row!
}
const read = async (id: string) => (await w.t.db.select().from(accounts).where(eq(accounts.id, id)))[0]!

describe('account manager', () => {
  it('starts an imported account through its proxy, imports the session once and stores the profile', async () => {
    const p = await proxy()
    const a = await account({ connectionMode: 'proxy', proxyId: p.id, sessionImportEnc: w.deps.cipher.encrypt('session-string') })
    const fake = fakeFactory()
    const onSessionStarted = vi.fn()
    const manager = createAccountManager(w.deps, fake.factory, { onSessionStarted }, { jitterMs: 0 })
    await manager.sync(a.id)

    expect(fake.last().importSession).toBe('session-string')
    expect(fake.last().proxy).toEqual({ type: 'socks5', host: p.host, port: 1080, username: 'u', password: 'pw' })
    expect(await read(a.id)).toMatchObject({ status: 'active', sessionImportEnc: null, phone: '77001234567', username: 'nox', firstName: 'Nox', dcId: 2 })
    expect(onSessionStarted).toHaveBeenCalledOnce()
    expect(manager.isRunning(a.id)).toBe(true)
    const [audit] = await w.t.db.select().from(auditLog).where(eq(auditLog.action, 'account.status')).orderBy(desc(auditLog.id)).limit(1)
    expect(audit).toMatchObject({ actorType: 'system', targetId: a.id, payload: { from: 'pending_check', to: 'active', reason: null } })
    await manager.stopAll()
  })

  it('marks a frozen account but keeps it running', async () => {
    const a = await account()
    const until = new Date('2026-12-01T00:00:00Z')
    const fake = fakeFactory((s) => (s.freeze = { since: new Date('2026-10-01T00:00:00Z'), until, appealUrl: 'https://t.me/spambot' }))
    const manager = createAccountManager(w.deps, fake.factory, {}, { jitterMs: 0 })
    await manager.sync(a.id)
    expect(await read(a.id)).toMatchObject({ status: 'frozen', frozenUntil: until })
    expect(manager.isRunning(a.id)).toBe(true)
    await manager.stopAll()
  })

  it('does not connect through a dead proxy and resumes when it comes back', async () => {
    const p = await proxy({ status: 'dead' })
    const a = await account({ connectionMode: 'proxy', proxyId: p.id })
    const fake = fakeFactory()
    const manager = createAccountManager(w.deps, fake.factory, {}, { jitterMs: 0 })
    await manager.sync(a.id)
    expect(fake.sessions).toHaveLength(0)
    expect(await read(a.id)).toMatchObject({ status: 'proxy_down', statusReason: 'Прокси не работает' })

    await w.t.db.update(proxies).set({ status: 'ok' }).where(eq(proxies.id, p.id))
    await manager.onProxyUp(p.id)
    expect(await read(a.id)).toMatchObject({ status: 'active' })

    await manager.onProxyDown(p.id)
    expect(fake.last().stopped).toBe(true)
    expect(await read(a.id)).toMatchObject({ status: 'proxy_down' })
    await manager.stopAll()
  })

  it('gives up on a revoked session and retries network failures', async () => {
    const revoked = await account()
    const flaky = await account()
    let attempts = 0
    const fake = fakeFactory((s) => {
      if (s.account.id === revoked.id) s.startResult = async () => Promise.reject(rpcError(401, 'AUTH_KEY_UNREGISTERED'))
      if (s.account.id === flaky.id) {
        const ok = s.startResult
        s.startResult = async () => (++attempts === 1 ? Promise.reject(new Error('connect ETIMEDOUT')) : ok())
      }
    })
    const manager = createAccountManager(w.deps, fake.factory, {}, { jitterMs: 0, retryDelaysMs: [30] })
    await manager.sync(revoked.id)
    await manager.sync(flaky.id)
    expect(await read(revoked.id)).toMatchObject({ status: 'unauthorized', statusReason: 'Сессия завершена в Telegram (ключ больше не действует)' })
    expect(await read(flaky.id)).toMatchObject({ status: 'error', statusReason: 'connect ETIMEDOUT' })
    await vi.waitFor(async () => expect((await read(flaky.id)).status).toBe('active'))
    expect(fake.sessions.filter((s) => s.account.id === revoked.id)).toHaveLength(1)
    await manager.stopAll()
  })

  it('reacts to errors reported later by a running client', async () => {
    const a = await account()
    const fake = fakeFactory()
    const manager = createAccountManager(w.deps, fake.factory, {}, { jitterMs: 0 })
    await manager.sync(a.id)
    fake.last().emitError(rpcError(401, 'SESSION_REVOKED'))
    await vi.waitFor(async () => expect((await read(a.id)).status).toBe('unauthorized'))
    expect(fake.last().stopped).toBe(true)
    expect(manager.isRunning(a.id)).toBe(false)
  })

  it('starts at most worker.connectConcurrency clients at a time', async () => {
    await w.deps.settings.update({ 'worker.connectConcurrency': 2 }, { adminId: null })
    for (let i = 0; i < 5; i++) await account({ status: 'active' })
    await account({ status: 'paused' })
    let inFlight = 0
    let peak = 0
    const fake = fakeFactory((s) => {
      const ok = s.startResult
      s.startResult = async () => {
        peak = Math.max(peak, ++inFlight)
        await new Promise((r) => setTimeout(r, 20))
        inFlight--
        return ok()
      }
    })
    const manager = createAccountManager(w.deps, fake.factory, {}, { jitterMs: 0 })
    await manager.startAll()
    expect(fake.sessions).toHaveLength(5)
    expect(peak).toBe(2)
    await manager.stopAll()
    await w.deps.settings.update({ 'worker.connectConcurrency': null }, { adminId: null })
  })

  it('logs out on request, lists sessions only for running accounts and refreshes profiles', async () => {
    const a = await account()
    const fake = fakeFactory((s) => (s.sessionList = [{ hash: '42', current: true } as never]))
    const manager = createAccountManager(w.deps, fake.factory, {}, { jitterMs: 0 })
    await expect(manager.sessions(a.id)).rejects.toBeInstanceOf(AccountNotRunningError)
    await manager.sync(a.id)
    expect(await manager.sessions(a.id)).toEqual([{ hash: '42', current: true }])
    await manager.terminateSession(a.id, '-77')
    expect(fake.last().terminated).toEqual(['-77'])

    fake.last().profile.mockResolvedValueOnce({ tgUserId: a.tgUserId, phone: '77001234567', username: 'renamed', firstName: 'Nox', lastName: null, isPremium: true, dcId: 2 })
    await manager.refreshProfiles()
    expect(await read(a.id)).toMatchObject({ username: 'renamed', isPremium: true })

    expect(await manager.stop(a.id, true)).toEqual({ stopped: true, loggedOut: true })
    expect(await manager.stop(a.id, true)).toEqual({ stopped: false, loggedOut: false })
    expect(fake.last().loggedOut).toBe(true)
    expect(manager.isRunning(a.id)).toBe(false)
  })
})
