import { auditLog } from '@workspace/db'
import { createTestDatabase, type TestDatabase } from '@workspace/db/testing'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'
import { sanitizeForAudit, writeAudit } from '../src/audit.ts'

let t: TestDatabase
beforeAll(async () => {
  t = await createTestDatabase(inject('pgAdminUrl'))
})
afterAll(async () => {
  await t.drop()
})

describe('sanitizeForAudit', () => {
  it('redacts secret-looking keys at any depth', () => {
    expect(
      sanitizeForAudit({ login: 'a', password: 'p', nested: { newPassword: 'x', apiKey: 'k', list: [{ token: 't', ok: 1 }] } }),
    ).toEqual({ login: 'a', password: '[redacted]', nested: { newPassword: '[redacted]', apiKey: '[redacted]', list: [{ token: '[redacted]', ok: 1 }] } })
  })

  it('redacts files and truncates long strings and deep objects', () => {
    const deep = { a: { b: { c: { d: { e: { f: { g: 1 } } } } } } }
    const out = sanitizeForAudit({ file: new Blob(['x']), long: 'x'.repeat(3000), deep }) as Record<string, unknown>
    expect(out.file).toBe('[redacted:file]')
    expect(String(out.long)).toMatch(/…\[truncated\]$/)
    expect(JSON.stringify(out.deep)).toContain('[truncated:depth]')
  })
})

describe('writeAudit', () => {
  it('stores a sanitized record for each actor type', async () => {
    await writeAudit(t.db, { actor: { type: 'cli' }, action: 'admin.create', payload: { login: 'x', password: 'p' }, result: 'ok' })
    await writeAudit(t.db, { actor: { type: 'system' }, action: 'settings.reload', result: 'error' })
    const rows = await t.db.select().from(auditLog).orderBy(auditLog.id)
    expect(rows.map((r) => [r.actorType, r.action, r.result, r.payload])).toEqual([
      ['cli', 'admin.create', 'ok', { login: 'x', password: '[redacted]' }],
      ['system', 'settings.reload', 'error', null],
    ])
  })
})
