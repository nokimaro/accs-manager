import { zipSync } from 'fflate'
import { accounts, auditLog, desc, eq, importBatches, importItems, proxies } from '@workspace/db'
import type { ImportBatchDto } from '@workspace/shared/accounts'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { loginAs, send, setupApp, type TestApp } from './helpers.ts'
import { makeTdataZip } from './tdata-fixture.ts'

let ta: TestApp
let cookie: string
beforeAll(async () => {
  ta = await setupApp()
  cookie = (await loginAs(ta)).cookie
})
afterAll(async () => {
  await ta.close()
})
beforeEach(async () => {
  await ta.t.db.delete(importBatches)
  await ta.t.db.delete(accounts)
  await ta.t.db.delete(proxies)
  ta.commands.sent = []
})

function upload(zip: Uint8Array, passcode?: string, name = 'tdata.zip') {
  const form = new FormData()
  form.set('file', new File([new Uint8Array(zip)], name, { type: 'application/zip' }))
  if (passcode !== undefined) form.set('passcode', passcode)
  return send(ta.app, '/api/imports', { cookie, body: form })
}

const device = { deviceModel: 'Desktop', systemVersion: 'Windows 11 x64', appVersion: '7.2.9 x64', langCode: 'ru' }

describe('tdata upload', () => {
  it('finds every account of a nested tdata and keeps the sessions encrypted', async () => {
    const res = await upload(await makeTdataZip({ users: [5001, 5002], folder: 'Telegram Portable' }))
    expect(res.status).toBe(201)
    const batch = (await res.json()) as ImportBatchDto
    expect(batch).toMatchObject({ filename: 'tdata.zip', status: 'ready' })
    expect(batch.items.map((i) => [i.pathInArchive, i.accountIndex, i.tgUserId, i.dcId, i.duplicateOf])).toEqual([
      ['Telegram Portable/tdata', 0, 5001, 2, null],
      ['Telegram Portable/tdata', 1, 5002, 2, null],
    ])
    const rows = await ta.t.db.select().from(importItems)
    expect(rows.every((r) => r.sessionEnc.startsWith('v1:'))).toBe(true)
    const [audit] = await ta.t.db.select().from(auditLog).where(eq(auditLog.action, 'account.import.upload')).orderBy(desc(auditLog.id)).limit(1)
    expect(audit!.payload).toEqual({ filename: 'tdata.zip', accounts: 2 })
  })

  it('asks for the local passcode and rejects a wrong one', async () => {
    const zip = await makeTdataZip({ users: [6001], passcode: 'local-pass' })
    expect(await (await upload(zip)).json()).toMatchObject({ error: 'passcode_required' })
    expect(await (await upload(zip, 'nope')).json()).toMatchObject({ error: 'passcode_invalid' })
    const ok = await upload(zip, 'local-pass')
    expect(ok.status).toBe(201)
    const [audit] = await ta.t.db.select().from(auditLog).where(eq(auditLog.action, 'account.import.upload')).orderBy(desc(auditLog.id)).limit(1)
    expect(JSON.stringify(audit!.payload)).not.toContain('local-pass')
  })

  it.each([
    ['no tdata inside', zipSync({ 'readme.txt': new Uint8Array([1]) }), 'tdata_not_found'],
    ['not a zip', new Uint8Array([1, 2, 3, 4]), 'zip_invalid'],
    ['a path escaping the folder', zipSync({ '../evil/key_datas': new Uint8Array([1]) }), 'zip_path'],
  ])('rejects %s', async (_, zip, error) => {
    const res = await upload(zip)
    expect(res.status).toBe(422)
    expect(await res.json()).toMatchObject({ error })
  })

  it('enforces the archive limits from settings', async () => {
    await ta.deps.settings.update({ 'import.maxFiles': 2 }, { adminId: null })
    try {
      expect(await (await upload(await makeTdataZip({ users: [7001] }))).json()).toMatchObject({ error: 'zip_files' })
    } finally {
      await ta.deps.settings.update({ 'import.maxFiles': null }, { adminId: null })
    }
    await ta.deps.settings.update({ 'import.maxZipSizeMb': 1 }, { adminId: null })
    try {
      // bigger than the 1 MB route limit; the global 1 MiB cap does not apply here, the route's does
      const tooBig = await upload(zipSync({ 'big.bin': new Uint8Array(1_200_000).map(() => Math.floor(Math.random() * 256)) }, { level: 0 }))
      expect(tooBig.status).toBe(413)
    } finally {
      await ta.deps.settings.update({ 'import.maxZipSizeMb': null }, { adminId: null })
    }
  })
})

describe('confirming an import', () => {
  async function prepared(users: number[]) {
    return (await (await upload(await makeTdataZip({ users }))).json()) as ImportBatchDto
  }
  // a counter, not Math.random: the tests share one database and proxy endpoints are unique
  let nextHost = 0
  const proxy = async (values: Partial<typeof proxies.$inferInsert> = {}) =>
    (await ta.t.db.insert(proxies).values({ source: 'manual', type: 'socks5', host: `10.3.3.${++nextHost}`, port: 1080, status: 'ok', latencyMs: 100, ...values }).returning())[0]!

  it('creates accounts with the chosen proxy, an automatic one or none, and starts them', async () => {
    const batch = await prepared([8001, 8002, 8003, 8004])
    const chosen = await proxy({ latencyMs: 300 })
    const auto = await proxy({ latencyMs: 50 })
    await proxy({ status: 'dead' })
    const [i1, i2, i3, i4] = batch.items
    const res = await send(ta.app, `/api/imports/${batch.id}/confirm`, {
      cookie,
      body: {
        items: [
          { id: i1!.id, decision: 'proxy', proxyId: chosen.id },
          { id: i2!.id, decision: 'auto' },
          { id: i3!.id, decision: 'direct' },
          { id: i4!.id, decision: 'skip' },
        ],
      },
    })
    expect(await res.json()).toEqual({ created: 3, skipped: 1 })
    const rows = await ta.t.db.select().from(accounts)
    const byUser = Object.fromEntries(rows.map((r) => [r.tgUserId, r]))
    expect(byUser[8001]).toMatchObject({ proxyId: chosen.id, connectionMode: 'proxy', status: 'pending_check', source: 'tdata', clientProfile: 'desktop', device })
    expect(byUser[8002]).toMatchObject({ proxyId: auto.id, connectionMode: 'proxy' })
    expect(byUser[8003]).toMatchObject({ proxyId: null, connectionMode: 'direct' })
    expect(byUser[8004]).toBeUndefined()
    expect(rows.every((r) => r.sessionImportEnc?.startsWith('v1:'))).toBe(true)
    expect(ta.commands.sent.map((c) => c.type)).toEqual(['account.sync', 'account.sync', 'account.sync'])

    const again = await send(ta.app, `/api/imports/${batch.id}/confirm`, { cookie, body: { items: [{ id: i4!.id, decision: 'skip' }] } })
    expect(await again.json()).toMatchObject({ error: 'already_confirmed' })
  })

  it('takes freshly added and failing proxies like the rest of the panel, "auto" preferring working ones', async () => {
    const batch = await prepared([9101, 9102, 9103])
    const [one, two, three] = batch.items
    const unchecked = await proxy({ status: 'unchecked', latencyMs: null })
    const failing = await proxy({ status: 'failing', latencyMs: 900 })
    const ok = await proxy({ status: 'ok', latencyMs: 300 })
    const res = await send(ta.app, `/api/imports/${batch.id}/confirm`, {
      cookie,
      body: {
        items: [
          { id: one!.id, decision: 'proxy', proxyId: unchecked.id },
          { id: two!.id, decision: 'auto' },
          { id: three!.id, decision: 'auto' },
        ],
      },
    })
    expect(res.status).toBe(200)
    const byUser = Object.fromEntries((await ta.t.db.select().from(accounts)).map((a) => [a.tgUserId, a.proxyId]))
    expect([byUser[9101], byUser[9102], byUser[9103]]).toEqual([unchecked.id, ok.id, failing.id])
  })

  it('refuses duplicates, busy or broken proxies and an empty pool for "auto"', async () => {
    const first = await prepared([9001])
    await send(ta.app, `/api/imports/${first.id}/confirm`, { cookie, body: { items: [{ id: first.items[0]!.id, decision: 'direct' }] } })

    const batch = await prepared([9001, 9002])
    const [dup, fresh] = batch.items
    expect(dup!.duplicateOf).not.toBeNull()
    const refuse = async (items: unknown[], error: string) => {
      const res = await send(ta.app, `/api/imports/${batch.id}/confirm`, { cookie, body: { items } })
      expect(res.status).toBe(409)
      expect(await res.json()).toMatchObject({ error })
    }
    await refuse([{ id: dup!.id, decision: 'direct' }], 'duplicate')
    const dead = await proxy({ status: 'dead' })
    await refuse([{ id: fresh!.id, decision: 'proxy', proxyId: dead.id }], 'proxy_unavailable')
    await refuse([{ id: fresh!.id, decision: 'auto' }], 'no_free_proxy')
    // nothing was half-done
    expect((await ta.t.db.select().from(accounts)).map((a) => a.tgUserId)).toEqual([9001])
  })
})
