import { eq, proxies } from '@workspace/db'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProxyChecker } from '../src/proxies/checker.ts'
import { createProxyHealth, isDue, needsCountry, sanitizeProxyError } from '../src/proxies/health.ts'
import { setupWorker, type TestWorker } from './helpers.ts'

let w: TestWorker
beforeAll(async () => {
  w = await setupWorker()
})
afterAll(async () => {
  await w.close()
})
beforeEach(async () => {
  await w.t.db.delete(proxies)
})

const minutes = (n: number) => n * 60_000
const at = (base: Date, ms: number) => new Date(base.getTime() + ms)

describe('scheduling rules', () => {
  const now = new Date('2026-10-03T12:00:00Z')
  it('checks new proxies at once, failing ones every minute, others at the interval', () => {
    expect(isDue({ status: 'unchecked', lastCheckAt: null }, now, minutes(5))).toBe(true)
    expect(isDue({ status: 'ok', lastCheckAt: at(now, -minutes(4)) }, now, minutes(5))).toBe(false)
    expect(isDue({ status: 'ok', lastCheckAt: at(now, -minutes(5)) }, now, minutes(5))).toBe(true)
    expect(isDue({ status: 'failing', lastCheckAt: at(now, -minutes(1)) }, now, minutes(5))).toBe(true)
    expect(isDue({ status: 'dead', lastCheckAt: at(now, -minutes(1)) }, now, minutes(5))).toBe(false)
  })
  it('asks Telegram for the country at most once a day', () => {
    expect(needsCountry({ tgCountry: null, tgCheckedAt: null }, now)).toBe(true)
    expect(needsCountry({ tgCountry: 'KZ', tgCheckedAt: at(now, -minutes(60)) }, now)).toBe(false)
    expect(needsCountry({ tgCountry: 'KZ', tgCheckedAt: at(now, -minutes(24 * 60)) }, now)).toBe(true)
  })
  it('never shows proxy credentials in errors', () => {
    expect(sanitizeProxyError(new Error('auth failed for kz1:pw-1 at 1.1.1.1'), { username: 'kz1', password: 'pw-1' })).toBe('auth failed for ***:*** at 1.1.1.1')
  })
})

function fakeChecker(behaviour: { fail?: boolean; country?: string } = {}) {
  const state = { fail: behaviour.fail ?? false }
  const checker: ProxyChecker & { state: typeof state } = {
    state,
    tunnel: vi.fn(async () => {
      if (state.fail) throw new Error('connect ECONNREFUSED')
      return 42
    }),
    country: vi.fn(async () => behaviour.country ?? 'KZ'),
  }
  return checker
}

// a counter, not Math.random: the tests of this file share one database and endpoints are unique
let nextHost = 0
const insertProxy = async (values: Partial<typeof proxies.$inferInsert> = {}) =>
  (await w.t.db.insert(proxies).values({ source: 'manual', type: 'socks5', host: `10.0.0.${++nextHost}`, port: 1080, ...values }).returning())[0]!

const read = async (id: string) => (await w.t.db.select().from(proxies).where(eq(proxies.id, id)))[0]!

describe('proxy health', () => {
  it('marks a working proxy ok with latency and the country Telegram sees, once', async () => {
    const checker = fakeChecker({ country: 'JP' })
    const health = createProxyHealth(w.deps, checker)
    const p = await insertProxy({ passwordEnc: w.deps.cipher.encrypt('pw'), username: 'u' })
    expect(await health.checkDue()).toBe(1)
    expect(await read(p.id)).toMatchObject({ status: 'ok', latencyMs: 42, tgCountry: 'JP', failStreak: 0, lastError: null })
    expect(checker.tunnel).toHaveBeenCalledWith(expect.objectContaining({ username: 'u', password: 'pw' }))
    // forced re-check within a day: tunnel again, no second MTProto exchange
    await health.checkById(p.id)
    expect(checker.tunnel).toHaveBeenCalledTimes(2)
    expect(checker.country).toHaveBeenCalledTimes(1)
  })

  it('counts failures: failing, then dead at the threshold; recovers to ok', async () => {
    await w.deps.settings.update({ 'proxy.failThreshold': 2 }, { adminId: null })
    const checker = fakeChecker({ fail: true })
    const onDown = vi.fn()
    const onUp = vi.fn()
    const health = createProxyHealth(w.deps, checker, { onDown, onUp })
    const p = await insertProxy({ status: 'ok' })

    expect(await health.checkById(p.id)).toBe('failing')
    expect(onDown).not.toHaveBeenCalled()
    expect(await health.checkById(p.id)).toBe('dead')
    expect(await read(p.id)).toMatchObject({ status: 'dead', failStreak: 2, lastError: 'connect ECONNREFUSED' })
    expect(onDown).toHaveBeenCalledExactlyOnceWith(p.id)
    expect(await health.checkById(p.id)).toBe('dead')
    expect(onDown).toHaveBeenCalledOnce()

    checker.state.fail = false
    expect(await health.checkById(p.id)).toBe('ok')
    expect(onUp).toHaveBeenCalledExactlyOnceWith(p.id)
    expect(await read(p.id)).toMatchObject({ failStreak: 0, lastError: null })
    await w.deps.settings.update({ 'proxy.failThreshold': null }, { adminId: null })
  })

  it('skips disabled and not-yet-issued proxies and expires overdue ones', async () => {
    const checker = fakeChecker()
    const onDown = vi.fn()
    const health = createProxyHealth(w.deps, checker, { onDown })
    const now = new Date()
    await insertProxy({ disabledAt: now })
    await insertProxy({ status: 'provisioning' })
    const overdue = await insertProxy({ status: 'ok', source: 'proxy_store', externalId: '1', expiresAt: at(now, -1000), lastCheckAt: now })
    const fresh = await insertProxy({ status: 'ok', lastCheckAt: now })
    const received = vi.fn()
    const off = w.deps.bus.subscribe(received)
    try {
      expect(await health.checkDue(now)).toBe(0)
      expect(checker.tunnel).not.toHaveBeenCalled()
      expect((await read(overdue.id)).status).toBe('expired')
      expect((await read(fresh.id)).status).toBe('ok')
      expect(onDown).toHaveBeenCalledExactlyOnceWith(overdue.id)
      await vi.waitFor(() => expect(received).toHaveBeenCalledWith({ type: 'proxies.changed', ids: [overdue.id] }))
      expect(await health.checkById(overdue.id)).toBeNull()
    } finally {
      off()
    }
  })
})
