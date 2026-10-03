import { auditLog } from '@workspace/db'
import { createTestDatabase, type TestDatabase } from '@workspace/db/testing'
import { eq } from 'drizzle-orm'
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

describe('sanitizeForAudit: text Postgres jsonb would reject', () => {
  it('strips NUL from values and keys, keeping the structure', () => {
    expect(sanitizeForAudit({ 'a\u0000b': 'x\u0000y', list: ['\u0000', { 'k\u0000': 1 }] })).toEqual({ ab: 'xy', list: ['', { k: 1 }] })
  })

  it('still redacts a secret key hidden behind a NUL', () => {
    expect(sanitizeForAudit({ 'pass\u0000word': 'p' })).toEqual({ password: '[redacted]' })
  })

  it('repairs lone surrogates, including a pair split by truncation', () => {
    const out = sanitizeForAudit({ lone: 'a\ud83d', split: `${'x'.repeat(1999)}😀tail` }) as Record<string, string>
    expect(out.lone).toBe('a\ufffd')
    expect(out.split).toMatch(/…\[truncated\]$/)
    expect(out.split?.isWellFormed()).toBe(true)
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

  it('stores records whose strings carry NUL or lone surrogates', async () => {
    await writeAudit(t.db, {
      actor: { type: 'cli' },
      action: 'probe\u0000.write',
      targetId: 'id\u0000',
      userAgent: 'ua\u0000',
      payload: { 'k\u0000': 'v\u0000', s: '\udc00' },
      result: 'ok',
    })
    const [row] = await t.db.select().from(auditLog).where(eq(auditLog.action, 'probe.write'))
    expect(row).toMatchObject({ targetId: 'id', userAgent: 'ua', payload: { k: 'v', s: '\ufffd' } })
  })
})
