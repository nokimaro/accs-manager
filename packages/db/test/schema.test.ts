import { eq, sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'
import { admins, adminSessions, settings } from '../src/index.ts'
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
    expect(res.rows[0]).toEqual({ n: 4 })
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
})
