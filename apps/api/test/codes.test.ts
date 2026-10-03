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
})
