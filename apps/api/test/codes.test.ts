import { accounts, codeMessages } from '@workspace/db'
import type { CodeDto } from '@workspace/shared/accounts'
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

const device = { deviceModel: 'Desktop', systemVersion: 'Windows 11 x64', appVersion: '7.2.9 x64', langCode: 'ru' }

describe('codes api', () => {
  it('lists the newest codes first with the account, filters by account and pages back', async () => {
    const [a, b] = await ta.t.db
      .insert(accounts)
      .values([
        { tgUserId: 1, phone: '77001234567', label: 'main', source: 'tdata', clientProfile: 'desktop', device, connectionMode: 'direct' },
        { tgUserId: 2, username: 'second', source: 'qr', clientProfile: 'own', device, connectionMode: 'direct' },
      ])
      .returning()
    const base = Date.parse('2026-10-03T10:00:00Z')
    await ta.t.db.insert(codeMessages).values([
      { accountId: a!.id, tgMessageId: 1, date: new Date(base), text: 'Your code is 111111', code: '111111' },
      { accountId: b!.id, tgMessageId: 1, date: new Date(base + 1000), text: 'Your code is 222222', code: '222222' },
      { accountId: a!.id, tgMessageId: 2, date: new Date(base + 2000), text: 'no code here', code: null },
    ])
    const get = async (query = '') => ((await (await send(ta.app, `/api/codes${query}`, { cookie })).json()) as { items: CodeDto[] }).items

    const all = await get()
    expect(all.map((c) => c.code)).toEqual([null, '222222', '111111'])
    expect(all[1]).toMatchObject({ account: { label: null, phone: null, username: 'second' }, text: 'Your code is 222222', notifiedAt: null })
    expect((await get(`?accountId=${a!.id}`)).map((c) => c.tgMessageId)).toEqual([2, 1])
    expect((await get(`?limit=1&before=${all[0]!.id}`)).map((c) => c.code)).toEqual(['222222'])
    expect((await send(ta.app, '/api/codes?limit=0', { cookie })).status).toBe(400)
  })

  it('orders by message time, so history caught up later stays below fresh codes, and pages back by that order', async () => {
    const [c] = await ta.t.db
      .insert(accounts)
      .values({ tgUserId: 3, phone: '77007654321', source: 'tdata', clientProfile: 'desktop', device, connectionMode: 'direct' })
      .returning()
    const now = Date.parse('2026-10-03T12:00:00Z')
    // inserted in this order: a fresh code first, then two old ones from a later catch-up (bigger ids)
    await ta.t.db.insert(codeMessages).values({ accountId: c!.id, tgMessageId: 50, date: new Date(now), text: 'Your code is 500005', code: '500005' })
    await ta.t.db.insert(codeMessages).values([
      { accountId: c!.id, tgMessageId: 10, date: new Date(now - 86_400_000), text: 'Your code is 100001', code: '100001' },
      { accountId: c!.id, tgMessageId: 11, date: new Date(now - 3_600_000), text: 'Your code is 110011', code: '110011' },
    ])
    const get = async (query: string) => ((await (await send(ta.app, `/api/codes${query}`, { cookie })).json()) as { items: CodeDto[] }).items
    const page1 = await get(`?accountId=${c!.id}&limit=2`)
    expect(page1.map((x) => x.code)).toEqual(['500005', '110011'])
    expect((await get(`?accountId=${c!.id}&limit=2&before=${page1[1]!.id}`)).map((x) => x.code)).toEqual(['100001'])
  })
})
