import { eq, sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'
import { accountAuth, accounts, admins, adminSessions, codeMessages, proxies, settings } from '../src/index.ts'
import { createTestDatabase, type TestDatabase } from '../src/testing.ts'

let t: TestDatabase

beforeAll(async () => {
  t = await createTestDatabase(inject('pgAdminUrl'))
})
afterAll(async () => {
  await t.drop()
})

describe('schema', () => {
  it('applies migrations idempotently', async () => {
    const { runMigrations } = await import('../src/migrate.ts')
    await runMigrations(t.db)
    const res = await t.db.execute(sql`select count(*)::int as n from information_schema.tables where table_schema = 'public'`)
    expect(res.rows[0]).toEqual({ n: 10 })
  })

  it('enforces unique admin login', async () => {
    await t.db.insert(admins).values({ login: 'alice', passwordHash: 'h' })
    await expect(t.db.insert(admins).values({ login: 'alice', passwordHash: 'h2' })).rejects.toThrow()
  })

  it('cascades sessions when an admin is deleted', async () => {
    const [a] = await t.db.insert(admins).values({ login: 'bob', passwordHash: 'h' }).returning()
    await t.db.insert(adminSessions).values({ adminId: a!.id, tokenHash: 'x', expiresAt: new Date(Date.now() + 1000) })
    await t.db.delete(admins).where(eq(admins.id, a!.id))
    expect(await t.db.select().from(adminSessions).where(eq(adminSessions.adminId, a!.id))).toEqual([])
  })

  it('stores arbitrary JSON in settings', async () => {
    await t.db.insert(settings).values({ key: 'k', value: { enc: 'v1:a:b:c' } })
    await t.db
      .insert(settings)
      .values({ key: 'k', value: [1, 2] })
      .onConflictDoUpdate({ target: settings.key, set: { value: [1, 2], updatedAt: new Date() } })
    const [row] = await t.db.select().from(settings).where(eq(settings.key, 'k'))
    expect(row?.value).toEqual([1, 2])
  })

  it('reads jsonb strings back as strings, even when they look like JSON', async () => {
    const values = ['-1001234567890', '0.25', 'true', 'null', '10m']
    await t.db.insert(settings).values(values.map((v) => ({ key: `str:${v}`, value: v })))
    const rows = await t.db.select().from(settings)
    expect(values.map((v) => rows.find((r) => r.key === `str:${v}`)?.value)).toEqual(values)
  })

  const device = { deviceModel: 'Desktop', systemVersion: 'Windows 11 x64', appVersion: '7.2.9 x64', langCode: 'ru' }
  const account = (tgUserId: number, proxyId: string | null = null) =>
    ({ tgUserId, source: 'tdata', clientProfile: 'desktop', device, connectionMode: proxyId ? 'proxy' : 'direct', proxyId }) as const

  it('treats a proxy without login as one endpoint (NULLS NOT DISTINCT)', async () => {
    const row = { source: 'manual', type: 'socks5', host: '10.0.0.1', port: 1080 } as const
    await t.db.insert(proxies).values(row)
    await expect(t.db.insert(proxies).values(row)).rejects.toThrow()
    await t.db.insert(proxies).values({ ...row, username: 'u' })
  })

  it('binds one proxy to at most one account and frees it when the proxy goes', async () => {
    const [p] = await t.db.insert(proxies).values({ source: 'manual', type: 'http', host: '10.0.0.2', port: 3128 }).returning()
    const [a] = await t.db.insert(accounts).values(account(1001, p!.id)).returning()
    await expect(t.db.insert(accounts).values(account(1002, p!.id))).rejects.toThrow()
    await t.db.delete(proxies).where(eq(proxies.id, p!.id))
    const [after] = await t.db.select().from(accounts).where(eq(accounts.id, a!.id))
    expect(after).toMatchObject({ proxyId: null, status: 'pending_check', device })
  })

  it('removes auth keys and codes together with the account', async () => {
    const [a] = await t.db.insert(accounts).values(account(2001)).returning()
    await t.db.insert(accountAuth).values([
      { accountId: a!.id, dcId: 2, authKeyEnc: 'v1:a:b:c' },
      { accountId: a!.id, dcId: 4, authKeyEnc: 'v1:d:e:f' },
    ])
    await t.db.insert(codeMessages).values({ accountId: a!.id, tgMessageId: 7, date: new Date(), text: 'Your code is 123456', code: '123456' })
    await expect(t.db.insert(codeMessages).values({ accountId: a!.id, tgMessageId: 7, date: new Date(), text: 'dup' })).rejects.toThrow()
    await t.db.delete(accounts).where(eq(accounts.id, a!.id))
    expect(await t.db.select().from(accountAuth).where(eq(accountAuth.accountId, a!.id))).toEqual([])
    expect(await t.db.select().from(codeMessages).where(eq(codeMessages.accountId, a!.id))).toEqual([])
  })
})
