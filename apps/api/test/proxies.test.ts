import { accounts, auditLog, proxies } from '@workspace/db'
import type { ProxyDto } from '@workspace/shared/proxies'
import { desc, eq } from '@workspace/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
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

const lastAudit = async (action: string) =>
  (await ta.t.db.select().from(auditLog).where(eq(auditLog.action, action)).orderBy(desc(auditLog.id)).limit(1))[0]

describe('proxies api', () => {
  it('requires a session', async () => {
    expect((await send(ta.app, '/api/proxies')).status).toBe(401)
  })

  it('adds a manual proxy: password encrypted, never returned, check requested', async () => {
    ta.commands.sent = []
    const res = await send(ta.app, '/api/proxies', {
      cookie,
      body: { type: 'socks5', host: '194.53.188.22', port: 50101, username: 'kz1', password: 's3cret-pass', tag: 'kz' },
    })
    expect(res.status).toBe(201)
    const dto = (await res.json()) as ProxyDto
    expect(dto).toMatchObject({ source: 'manual', type: 'socks5', host: '194.53.188.22', username: 'kz1', hasPassword: true, status: 'unchecked', account: null })
    expect(JSON.stringify(dto)).not.toContain('s3cret-pass')
    const [row] = await ta.t.db.select().from(proxies).where(eq(proxies.id, dto.id))
    expect(row!.passwordEnc).toMatch(/^v1:/)
    expect(ta.deps.cipher.decrypt(row!.passwordEnc!)).toBe('s3cret-pass')
    expect(ta.commands.sent).toEqual([{ type: 'proxy.check', proxyId: dto.id }])
    expect(JSON.stringify((await lastAudit('proxy.create'))!.payload)).not.toContain('s3cret-pass')

    const again = await send(ta.app, '/api/proxies', { cookie, body: { type: 'socks5', host: '194.53.188.22', port: 50101, username: 'kz1', password: 'x' } })
    expect(again.status).toBe(409)
    expect(await again.json()).toMatchObject({ error: 'proxy_exists' })
  })

  it('previews a pasted list: new, invalid, repeated and already-known lines; no passwords echoed', async () => {
    const text = [
      'socks5://kz1:s3cret-pass@194.53.188.22:50101', // already in the pool
      '194.53.188.98:50100:kz2:pw-two',
      'garbage',
      '194.53.188.98:50100:kz2:pw-two',
    ].join('\n')
    const res = await send(ta.app, '/api/proxies/import/preview', { cookie, body: { text, defaultType: 'http' } })
    expect(res.status).toBe(200)
    const preview = await res.json()
    expect(preview).toEqual({
      proxies: [{ line: 2, type: 'http', host: '194.53.188.98', port: 50100, username: 'kz2' }],
      errors: [{ line: 3, text: 'garbage', reason: 'Ожидается host:port' }],
      duplicates: [
        { line: 1, text: 'socks5://kz1:s3cret-pass@194.53.188.22:50101', reason: 'exists' },
        { line: 4, text: '194.53.188.98:50100:kz2:pw-two', reason: 'repeated' },
      ],
    })
  })

  it('imports a list without writing the raw text into the audit log', async () => {
    const text = '194.53.188.98:50100:kz2:pw-two\n194.53.188.215:50100:kz3:pw-three\nsocks5://kz1:s3cret-pass@194.53.188.22:50101'
    const res = await send(ta.app, '/api/proxies/import', { cookie, body: { text, defaultType: 'http', tag: 'batch-1' } })
    expect(await res.json()).toEqual({ created: 2, skipped: 1 })
    const audit = await lastAudit('proxy.import')
    expect(audit!.payload).toEqual({ created: 2, skipped: 1, defaultType: 'http', tag: 'batch-1' })
    const list = ((await (await send(ta.app, '/api/proxies', { cookie })).json()) as { items: ProxyDto[] }).items
    expect(list.filter((p) => p.tag === 'batch-1')).toHaveLength(2)
  })

  it('shows the bound account and protects bound and synced proxies', async () => {
    const [bound] = await ta.t.db.insert(proxies).values({ source: 'manual', type: 'http', host: '10.1.1.1', port: 3128 }).returning()
    const [synced] = await ta.t.db.insert(proxies).values({ source: 'proxy_store', externalId: '5133763', type: 'http', host: '10.1.1.2', port: 3128 }).returning()
    const [loose] = await ta.t.db.insert(proxies).values({ source: 'manual', type: 'http', host: '10.1.1.3', port: 3128 }).returning()
    const device = { deviceModel: 'Desktop', systemVersion: 'Windows 11 x64', appVersion: '7.2.9 x64', langCode: 'ru' }
    const [account] = await ta.t.db
      .insert(accounts)
      .values({ tgUserId: 777, phone: '77001234567', label: 'main', source: 'tdata', clientProfile: 'desktop', device, connectionMode: 'proxy', proxyId: bound!.id })
      .returning()

    const list = ((await (await send(ta.app, '/api/proxies', { cookie })).json()) as { items: ProxyDto[] }).items
    expect(list.find((p) => p.id === bound!.id)!.account).toEqual({ id: account!.id, label: 'main', phone: '77001234567', username: null })

    const disableBound = await send(ta.app, `/api/proxies/${bound!.id}`, { cookie, method: 'PATCH', body: { disabled: true } })
    expect(disableBound.status).toBe(409)
    expect((await send(ta.app, `/api/proxies/${bound!.id}`, { cookie, method: 'DELETE' })).status).toBe(409)
    expect(await (await send(ta.app, `/api/proxies/${synced!.id}`, { cookie, method: 'DELETE' })).json()).toMatchObject({ error: 'managed_by_sync' })

    const disabled = await (await send(ta.app, `/api/proxies/${synced!.id}`, { cookie, method: 'PATCH', body: { disabled: true, tag: 'kz' } })).json()
    expect(disabled).toMatchObject({ tag: 'kz', disabledAt: expect.any(String) })
    const enabled = (await (await send(ta.app, `/api/proxies/${synced!.id}`, { cookie, method: 'PATCH', body: { disabled: false } })).json()) as ProxyDto
    expect(enabled.disabledAt).toBeNull()

    expect((await send(ta.app, `/api/proxies/${loose!.id}`, { cookie, method: 'DELETE' })).status).toBe(204)
    expect((await send(ta.app, `/api/proxies/${loose!.id}`, { cookie, method: 'DELETE' })).status).toBe(404)
  })

  it('shows the last proxy-store sync written by the worker', async () => {
    expect(await (await send(ta.app, '/api/proxies/sync-status', { cookie })).json()).toEqual({ status: null })
    const status = { at: '2026-10-03T10:00:00.000Z', ok: false, error: 'proxy-store: bad key', created: 0, updated: 0, expired: 0, skipped: 0 }
    await ta.deps.redis.set('accs:proxy-store:last-sync', JSON.stringify(status))
    try {
      expect(await (await send(ta.app, '/api/proxies/sync-status', { cookie })).json()).toEqual({ status })
    } finally {
      await ta.deps.redis.del('accs:proxy-store:last-sync')
    }
  })

  it('asks the worker to check one proxy or to sync proxy-store', async () => {
    const [p] = await ta.t.db.insert(proxies).values({ source: 'manual', type: 'http', host: '10.2.2.2', port: 80 }).returning()
    ta.commands.sent = []
    expect((await send(ta.app, `/api/proxies/${p!.id}/check`, { cookie, method: 'POST' })).status).toBe(202)
    expect((await send(ta.app, '/api/proxies/sync', { cookie, method: 'POST' })).status).toBe(202)
    expect(ta.commands.sent).toEqual([{ type: 'proxy.check', proxyId: p!.id }, { type: 'proxy.sync' }])
  })
})
