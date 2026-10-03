import { randomBytes, randomUUID } from 'node:crypto'
import { settings as settingsTable } from '@workspace/db'
import { createTestDatabase, type TestDatabase } from '@workspace/db/testing'
import { createCipher } from '@workspace/shared/crypto'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it, vi } from 'vitest'
import { createEventBus, type EventBus } from '../src/bus.ts'
import { createRedis, type Redis } from '../src/redis.ts'
import { SettingsService } from '../src/settings-service.ts'

const cipher = createCipher(randomBytes(32).toString('base64'))
let t: TestDatabase
const redis: Redis[] = []
let channel: string

async function makeBus(): Promise<EventBus> {
  const pub = createRedis(inject('redisUrl'), 'pub')
  const sub = createRedis(inject('redisUrl'), 'sub')
  redis.push(pub, sub)
  return createEventBus({ publisher: pub, subscriber: sub, channel })
}

async function makeService(): Promise<SettingsService> {
  return SettingsService.create({ db: t.db, cipher, bus: await makeBus() })
}

beforeAll(async () => {
  t = await createTestDatabase(inject('pgAdminUrl'))
})
beforeEach(async () => {
  channel = `test:${randomUUID()}`
  await t.db.delete(settingsTable)
})
afterAll(async () => {
  await Promise.all(redis.map((r) => r.quit()))
  await t.drop()
})

describe('SettingsService', () => {
  it('returns code defaults when nothing is stored', async () => {
    const s = await makeService()
    expect(s.get('worker.connectConcurrency')).toBe(5)
    expect(s.get('notify.botToken')).toBeNull()
    expect(s.snapshot()['worker.connectConcurrency']).toMatchObject({ value: 5, overridden: false, isSet: true })
  })

  it('updates, persists and reports a diff', async () => {
    const s = await makeService()
    const r = await s.update({ 'worker.connectConcurrency': 9 }, { adminId: null })
    expect(r).toEqual({ ok: true, diff: [{ key: 'worker.connectConcurrency', from: 5, to: 9 }] })
    expect(s.get('worker.connectConcurrency')).toBe(9)
    const fresh = await makeService()
    expect(fresh.get('worker.connectConcurrency')).toBe(9)
  })

  it('encrypts secrets at rest and never exposes them in the snapshot or diff', async () => {
    const s = await makeService()
    const r = await s.update({ 'notify.botToken': '123:ABC' }, { adminId: null })
    expect(r).toEqual({ ok: true, diff: [{ key: 'notify.botToken', from: '[redacted]', to: '[redacted]' }] })
    const [row] = await t.db.select().from(settingsTable).where(eq(settingsTable.key, 'notify.botToken'))
    expect(JSON.stringify(row?.value)).not.toContain('123:ABC')
    expect(row?.value).toMatchObject({ enc: expect.stringMatching(/^v1:/) })
    expect(s.get('notify.botToken')).toBe('123:ABC')
    expect(s.snapshot()['notify.botToken']).toMatchObject({ value: null, isSet: true, overridden: true })
  })

  it('null removes the override', async () => {
    const s = await makeService()
    await s.update({ 'proxy.failThreshold': 7, 'notify.botToken': 'x' }, { adminId: null })
    await s.update({ 'proxy.failThreshold': null, 'notify.botToken': null }, { adminId: null })
    expect(s.get('proxy.failThreshold')).toBe(3)
    expect(s.get('notify.botToken')).toBeNull()
    expect(await t.db.select().from(settingsTable)).toEqual([])
  })

  it('is all-or-nothing on validation errors', async () => {
    const s = await makeService()
    const r = await s.update({ 'proxy.failThreshold': 7, 'proxy.checkInterval': 'soon' }, { adminId: null })
    expect(r.ok).toBe(false)
    expect(await t.db.select().from(settingsTable)).toEqual([])
    expect(s.get('proxy.failThreshold')).toBe(3)
  })

  it('falls back to the default when a stored value no longer validates or decrypts', async () => {
    await t.db.insert(settingsTable).values([
      { key: 'worker.connectConcurrency', value: 'not-a-number' },
      { key: 'notify.botToken', value: { enc: 'v1:AAAA:AAAA:AAAA' } },
      { key: 'removed.from.code', value: 1 },
    ])
    const s = await makeService()
    expect(s.get('worker.connectConcurrency')).toBe(5)
    expect(s.get('notify.botToken')).toBeNull()
  })

  it('propagates changes to other instances and fires onChange there', async () => {
    const writer = await makeService()
    const reader = await makeService()
    const listener = vi.fn()
    reader.onChange('proxy.checkInterval', listener)
    await writer.update({ 'proxy.checkInterval': '10m' }, { adminId: null })
    await vi.waitFor(() => expect(reader.get('proxy.checkInterval')).toBe('10m'))
    expect(listener).toHaveBeenCalledWith('10m', '5m')
  })

  it('keeps a committed update even when broadcasting fails', async () => {
    const failingBus: EventBus = {
      publish: async () => {
        throw new Error('redis down')
      },
      subscribe: () => () => undefined,
      onReconnect: () => () => undefined,
      close: async () => undefined,
    }
    const s = await SettingsService.create({ db: t.db, cipher, bus: failingBus })
    const r = await s.update({ 'proxy.failThreshold': 6 }, { adminId: null })
    expect(r.ok).toBe(true)
    expect(s.get('proxy.failThreshold')).toBe(6)
  })

  it('re-reads everything after the bus reconnects: a change broadcast in the gap is not lost', async () => {
    const pub = createRedis(inject('redisUrl'), 'pub')
    const sub = createRedis(inject('redisUrl'), 'sub')
    redis.push(pub, sub)
    const s = await SettingsService.create({ db: t.db, cipher, bus: await createEventBus({ publisher: pub, subscriber: sub, channel }) })
    // written by another process (CLI, worker) while this subscriber is offline: its broadcast never arrives
    await t.db.insert(settingsTable).values({ key: 'proxy.failThreshold', value: 8 })
    sub.disconnect(true)
    await vi.waitFor(() => expect(s.get('proxy.failThreshold')).toBe(8), { timeout: 5_000 })
    s.close()
  })
})
