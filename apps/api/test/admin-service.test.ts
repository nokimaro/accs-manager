import { createTestDatabase, type TestDatabase } from '@workspace/db/testing'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'
import { AdminError, createAdmin, disableAdmin } from '../src/services/admins.ts'

let t: TestDatabase
beforeAll(async () => {
  t = await createTestDatabase(inject('pgAdminUrl'))
})
afterAll(async () => {
  await t.drop()
})

describe('disableAdmin', () => {
  it('never lets two concurrent disables remove the last active admins', async () => {
    const a = await createAdmin(t.db, { login: 'race-a', password: 'long enough password' })
    const b = await createAdmin(t.db, { login: 'race-b', password: 'long enough password' })
    const results = await Promise.allSettled([disableAdmin(t.db, a.id), disableAdmin(t.db, b.id)])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    const rejected = results.find((r): r is PromiseRejectedResult => r.status === 'rejected')
    expect(rejected?.reason).toBeInstanceOf(AdminError)
  })
})
