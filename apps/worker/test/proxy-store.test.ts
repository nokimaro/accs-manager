import { accounts, eq, proxies } from '@workspace/db'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mapProxyStoreList, readSyncStatus, syncProxyStore, type ProxyStoreFetch } from '../src/proxies/proxy-store.ts'
import { setupWorker, type TestWorker } from './helpers.ts'

let w: TestWorker
// the api tests read the real status key from the same Redis
let statusKey: string
beforeAll(async () => {
  w = await setupWorker()
  statusKey = `test:proxy-store:${w.deps.queuePrefix}`
})
afterAll(async () => {
  await w.close()
})
beforeEach(async () => {
  await w.t.db.delete(accounts)
  await w.t.db.delete(proxies)
  await w.deps.settings.update({ 'proxyStore.enabled': true, 'proxyStore.apiKey': 'k3y-0123456789abcdef' }, { adminId: null })
})

const END = 1_793_571_000 // 2026-11-02
const item = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  ip: `194.53.188.${id.slice(-2)}`,
  port: '50101',
  user: `user${id}`,
  pass: `pass${id}`,
  type: 'socks',
  country: 'kz',
  category: 'for_all',
  active: '1',
  date: '2026-10-02 00:30:00',
  date_end: '2026-11-02 00:30:00',
  unixtime: END - 2_592_000,
  unixtime_end: END,
  order_id: '900',
  autoprolong: '0',
  comment: '',
  ...over,
})

function fakeFetch(list: unknown) {
  const urls: string[] = []
  const fn: ProxyStoreFetch = vi.fn(async (url: string) => {
    urls.push(url)
    return { ok: true, status: 200, json: async () => ({ status: 'ok', list }) }
  })
  return Object.assign(fn, { urls })
}

it('maps only active proxies of the configured country and category', () => {
  const mapped = mapProxyStoreList(
    [item('5133770'), item('5133763', { type: 'http', port: '50100' }), item('4698704', { country: 'ru', category: 'vkontakte' }), item('5133999', { ip: '0.0.0.0', port: '0', user: '', pass: '' }), item('5133998', { active: '0' })] as never,
    { country: 'kz', category: 'for_all' },
  )
  expect(mapped.map((m) => [m.externalId, m.type, m.provisioning])).toEqual([
    ['5133770', 'socks5', false],
    ['5133763', 'http', false],
    ['5133999', 'socks5', true],
  ])
  expect(mapped[0]).toMatchObject({ host: '194.53.188.70', port: 50101, username: 'user5133770', password: 'pass5133770', expiresAt: new Date(END * 1000) })
})

describe('syncProxyStore', () => {
  it('does nothing while disabled or without an API key', async () => {
    await w.deps.settings.update({ 'proxyStore.enabled': false }, { adminId: null })
    const fetch = fakeFetch({})
    expect(await syncProxyStore(w.deps, fetch, {}, statusKey)).toBeNull()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('adds new proxies, keeps passwords encrypted and leaves manual ones alone', async () => {
    const [manual] = await w.t.db.insert(proxies).values({ source: 'manual', type: 'http', host: '10.9.9.9', port: 80 }).returning()
    const fetch = fakeFetch({ '5133770': item('5133770'), '5133999': item('5133999', { ip: '0.0.0.0', port: '0', user: '', pass: '' }), '4698704': item('4698704', { country: 'ru' }) })
    const result = await syncProxyStore(w.deps, fetch, {}, statusKey)
    expect(result).toMatchObject({ ok: true, created: 2, updated: 0, expired: 0 })
    expect(fetch.urls[0]).toBe('https://proxy-store.com/api/k3y-0123456789abcdef/getproxy/')
    const rows = await w.t.db.select().from(proxies).where(eq(proxies.source, 'proxy_store'))
    expect(rows.map((r) => [r.externalId, r.status]).sort()).toEqual([
      ['5133770', 'unchecked'],
      ['5133999', 'provisioning'],
    ])
    const issued = rows.find((r) => r.externalId === '5133770')!
    expect(w.deps.cipher.decrypt(issued.passwordEnc!)).toBe('pass5133770')
    expect(issued.providerMeta).toEqual({ orderId: '900', autoprolong: false, comment: null })
    expect((await w.t.db.select().from(proxies).where(eq(proxies.id, manual!.id)))[0]!.status).toBe('unchecked')
    expect(await readSyncStatus(w.deps.redis, statusKey)).toMatchObject({ ok: true, created: 2 })
  })

  it('updates changed credentials (reconnecting the bound account) and expires vanished proxies', async () => {
    await syncProxyStore(w.deps, fakeFetch({ '5133770': item('5133770'), '5133771': item('5133771') }), {}, statusKey)
    const rows = await w.t.db.select().from(proxies)
    const changedRow = rows.find((r) => r.externalId === '5133770')!
    const goneRow = rows.find((r) => r.externalId === '5133771')!
    await w.t.db.update(proxies).set({ status: 'ok', tgCountry: 'KZ' }).where(eq(proxies.id, changedRow.id))

    const onChanged = vi.fn()
    const onDown = vi.fn()
    const result = await syncProxyStore(w.deps, fakeFetch({ '5133770': item('5133770', { ip: '194.53.188.99', pass: 'rotated' }) }), { onChanged, onDown }, statusKey)
    expect(result).toMatchObject({ ok: true, created: 0, updated: 1, expired: 1 })
    const after = (await w.t.db.select().from(proxies).where(eq(proxies.id, changedRow.id)))[0]!
    expect(after).toMatchObject({ host: '194.53.188.99', status: 'unchecked', tgCountry: null, lastCheckAt: null })
    expect(w.deps.cipher.decrypt(after.passwordEnc!)).toBe('rotated')
    expect(onChanged).toHaveBeenCalledExactlyOnceWith(changedRow.id)
    expect((await w.t.db.select().from(proxies).where(eq(proxies.id, goneRow.id)))[0]!.status).toBe('expired')
    expect(onDown).toHaveBeenCalledExactlyOnceWith(goneRow.id)
  })

  it('records a failed sync without leaking the API key', async () => {
    const failing: ProxyStoreFetch = async () => {
      throw new Error('getaddrinfo ENOTFOUND for https://proxy-store.com/api/k3y-0123456789abcdef/getproxy/')
    }
    const result = await syncProxyStore(w.deps, failing, {}, statusKey)
    expect(result).toMatchObject({ ok: false, error: 'getaddrinfo ENOTFOUND for https://proxy-store.com/api/***/getproxy/' })
    expect(JSON.stringify(await readSyncStatus(w.deps.redis, statusKey))).not.toContain('k3y-0123456789abcdef')
  })
})
