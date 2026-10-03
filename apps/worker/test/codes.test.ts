import { accounts, adminSessions, admins, codeMessages, eq, importBatches } from '@workspace/db'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createAccountManager } from '../src/accounts/manager.ts'
import { createCodeCollector } from '../src/codes/collector.ts'
import { extractCode } from '../src/codes/extract.ts'
import { housekeeping } from '../src/housekeeping.ts'
import { fakeFactory } from './fake-session.ts'
import { setupWorker, type TestWorker } from './helpers.ts'

describe('extractCode', () => {
  // layer 229: keyboardInlineButton { type: inlineButtonTypeCopy { copyText } }
  const markup = (code: string) => ({
    _: 'replyInlineMarkup',
    rows: [{ _: 'keyboardButtonRow', buttons: [{ _: 'keyboardInlineButton', text: 'Copy Code', type: { _: 'inlineButtonTypeCopy', copyText: code } }] }],
  })
  it('takes the code from the Copy Code button', () => {
    expect(extractCode('Your code is 575571', markup('575571'))).toBe('575571')
    expect(extractCode('Код: см. кнопку', markup('A1B2C3'))).toBe('A1B2C3')
  })
  it('falls back to the first standalone 4–8 digit number', () => {
    expect(extractCode('Your code is 276350', null)).toBe('276350')
    expect(extractCode('Код подтверждения для +77001234567: 4093', null)).toBe('4093')
    expect(extractCode('Order 2026-10-03, code 469894.', null)).toBe('2026')
    expect(extractCode('Добро пожаловать!', null)).toBeNull()
  })
})

let w: TestWorker
beforeAll(async () => {
  w = await setupWorker()
})
afterAll(async () => {
  await w.close()
})
beforeEach(async () => {
  await w.t.db.delete(accounts)
})

const device = { deviceModel: 'Desktop', systemVersion: 'Windows 11 x64', appVersion: '7.2.9 x64', langCode: 'ru' }
const insertAccount = async () =>
  (await w.t.db.insert(accounts).values({ tgUserId: Math.floor(Math.random() * 1e9), source: 'tdata', clientProfile: 'desktop', device, connectionMode: 'direct' }).returning())[0]!
const msg = (id: number, text: string, senderId = 489000, ageMs = 0) => ({ id, date: new Date(Date.now() - ageMs), text, senderId, markup: null })

describe('code collector', () => {
  it('stores live codes from @VerificationCodes only, once, and announces them', async () => {
    const a = await insertAccount()
    const onCode = vi.fn()
    const collector = createCodeCollector(w.deps, { onCode })
    const fake = fakeFactory()
    const manager = createAccountManager(w.deps, fake.factory, { onSessionStarted: collector.attach }, { jitterMs: 0 })
    const events = vi.fn()
    const off = w.deps.bus.subscribe(events)
    try {
      await manager.sync(a.id)
      const session = fake.last()
      session.emitMessage(msg(10, 'Your code is 575571'))
      session.emitMessage(msg(11, 'hello from a friend', 12345))
      session.emitMessage(msg(10, 'Your code is 575571'))
      await vi.waitFor(() => expect(onCode).toHaveBeenCalledOnce())
      const rows = await w.t.db.select().from(codeMessages).where(eq(codeMessages.accountId, a.id))
      expect(rows.map((r) => [r.tgMessageId, r.code])).toEqual([[10, '575571']])
      expect(onCode).toHaveBeenCalledWith(expect.objectContaining({ code: '575571' }), expect.objectContaining({ id: a.id }), true)
      await vi.waitFor(() => expect(events).toHaveBeenCalledWith(expect.objectContaining({ type: 'code.new', accountId: a.id, code: '575571' })))
    } finally {
      off()
      await manager.stopAll()
    }
  })

  it('catches up on messages missed while offline, after the last stored one', async () => {
    const a = await insertAccount()
    await w.t.db.insert(codeMessages).values({ accountId: a.id, tgMessageId: 20, date: new Date(Date.now() - 3_600_000), text: 'Your code is 111111', code: '111111' })
    const onCode = vi.fn()
    const collector = createCodeCollector(w.deps, { onCode })
    const fake = fakeFactory((s) => {
      s.historyMessages = [msg(19, 'old 999999', 489000, 7_200_000), msg(21, 'Your code is 276350', 489000, 600_000), msg(22, 'Your code is 409369')]
    })
    const manager = createAccountManager(w.deps, fake.factory, { onSessionStarted: collector.attach }, { jitterMs: 0 })
    try {
      await manager.sync(a.id)
      expect(fake.last().history).toHaveBeenCalledWith(489000, 20, 100)
      const codes = (await w.t.db.select().from(codeMessages).where(eq(codeMessages.accountId, a.id))).map((r) => r.code).sort()
      expect(codes).toEqual(['111111', '276350', '409369'])
      expect(onCode.mock.calls.map((c) => [c[0].code, c[2]])).toEqual([
        ['276350', false],
        ['409369', false],
      ])
    } finally {
      await manager.stopAll()
    }
  })
})

describe('code collector resilience', () => {
  it('keeps trying to resolve @VerificationCodes and to catch up when Telegram fails at first', async () => {
    const a = await insertAccount()
    const collector = createCodeCollector(w.deps, {}, { retryDelaysMs: [20] })
    const fake = fakeFactory((s) => {
      s.historyMessages = [msg(5, 'Your code is 123456', 489000, 60_000)]
      s.resolveUserId.mockRejectedValueOnce(new Error('connection reset'))
      s.history.mockRejectedValueOnce(new Error('connection reset'))
    })
    const manager = createAccountManager(w.deps, fake.factory, { onSessionStarted: collector.attach }, { jitterMs: 0 })
    try {
      await manager.sync(a.id)
      await vi.waitFor(async () => {
        const rows = await w.t.db.select().from(codeMessages).where(eq(codeMessages.accountId, a.id))
        expect(rows.map((r) => r.code)).toEqual(['123456'])
      })
      fake.last().emitMessage(msg(6, 'Your code is 654321'))
      await vi.waitFor(async () => expect(await w.t.db.select().from(codeMessages).where(eq(codeMessages.accountId, a.id))).toHaveLength(2))
    } finally {
      await manager.stopAll()
    }
  })

  it('does not bring back history older than the retention period', async () => {
    const a = await insertAccount()
    const collector = createCodeCollector(w.deps)
    const day = 86_400_000
    const fake = fakeFactory((s) => (s.historyMessages = [msg(7, 'Your code is 700007', 489000, 40 * day), msg(8, 'Your code is 800008', 489000, day)]))
    const manager = createAccountManager(w.deps, fake.factory, { onSessionStarted: collector.attach }, { jitterMs: 0 })
    try {
      await manager.sync(a.id)
      const rows = await w.t.db.select().from(codeMessages).where(eq(codeMessages.accountId, a.id))
      expect(rows.map((r) => r.code)).toEqual(['800008'])
    } finally {
      await manager.stopAll()
    }
  })
})

describe('housekeeping', () => {
  it('drops old codes, expired import drafts and expired admin sessions', async () => {
    const a = await insertAccount()
    const now = new Date()
    await w.t.db.insert(codeMessages).values([
      { accountId: a.id, tgMessageId: 1, date: new Date(now.getTime() - 31 * 86_400_000), text: 'old' },
      { accountId: a.id, tgMessageId: 2, date: new Date(now.getTime() - 86_400_000), text: 'fresh' },
    ])
    await w.t.db.insert(importBatches).values([
      { filename: 'gone.zip', expiresAt: new Date(now.getTime() - 1000) },
      { filename: 'kept.zip', expiresAt: new Date(now.getTime() + 60_000) },
    ])
    const [admin] = await w.t.db.insert(admins).values({ login: 'hk', passwordHash: 'x' }).returning()
    await w.t.db.insert(adminSessions).values([
      { adminId: admin!.id, tokenHash: 'expired', expiresAt: new Date(now.getTime() - 1000) },
      { adminId: admin!.id, tokenHash: 'live', expiresAt: new Date(now.getTime() + 60_000) },
    ])
    expect(await housekeeping(w.deps, now)).toEqual({ codes: 1, imports: 1, sessions: 1 })
    expect((await w.t.db.select().from(codeMessages)).map((r) => r.text)).toEqual(['fresh'])
    expect((await w.t.db.select().from(importBatches)).map((b) => b.filename)).toEqual(['kept.zip'])
  })
})
