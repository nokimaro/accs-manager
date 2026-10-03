import { randomBytes } from 'node:crypto'
import { TelegramClient } from '@mtcute/node'
import { defaultProductionDc, readStringSession, writeStringSession } from '@mtcute/core/utils.js'
import { accountAuth, accounts, eq } from '@workspace/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createAccountStorage, deleteAccountStorage, EncryptedAuthKeys, prepareMtcuteStorage } from '../src/telegram/storage.ts'
import { setupWorker, type TestWorker } from './helpers.ts'

let w: TestWorker
beforeAll(async () => {
  w = await setupWorker()
  await prepareMtcuteStorage(w.deps.pool, w.t.db, w.deps.cipher)
})
afterAll(async () => {
  await w.close()
})

const device = { deviceModel: 'Desktop', systemVersion: 'Windows 11 x64', appVersion: '7.2.9 x64', langCode: 'ru' }
async function newAccount(tgUserId: number): Promise<string> {
  const [row] = await w.t.db.insert(accounts).values({ tgUserId, source: 'tdata', clientProfile: 'desktop', device, connectionMode: 'direct' }).returning()
  return row!.id
}

const client = (storageAccountId: string) =>
  new TelegramClient({ apiId: 2040, apiHash: 'b18441a1ff607e10a989891a5462e627', storage: createAccountStorage(w.deps.pool, w.t.db, w.deps.cipher, storageAccountId), logLevel: 0 })

describe('encrypted auth keys', () => {
  it('stores keys encrypted per account and DC', async () => {
    const accountId = await newAccount(1)
    const repo = new EncryptedAuthKeys(w.t.db, w.deps.cipher, accountId)
    const key = new Uint8Array(randomBytes(256))
    await repo.set(2, key)
    const [row] = await w.t.db.select().from(accountAuth).where(eq(accountAuth.accountId, accountId))
    expect(row!.authKeyEnc).toMatch(/^v1:/)
    expect(row!.authKeyEnc).not.toContain(Buffer.from(key).toString('base64').slice(0, 24))
    expect(await repo.get(2)).toEqual(key)
    expect(await repo.get(4)).toBeNull()
    await repo.set(4, key)
    await repo.deleteByDc(2)
    expect(await repo.get(2)).toBeNull()
    await repo.deleteAll()
    expect(await w.t.db.select().from(accountAuth).where(eq(accountAuth.accountId, accountId))).toEqual([])
  })
})

describe('account storage', () => {
  it('imports a session, keeps the key only in account_auth and survives a new client', async () => {
    const accountId = await newAccount(424242)
    const authKey = new Uint8Array(randomBytes(256))
    const session = writeStringSession({
      version: 3,
      primaryDcs: { main: defaultProductionDc.main, media: defaultProductionDc.media },
      self: { userId: 424242, isBot: false, isPremium: false, usernames: [] },
      authKey,
    })

    const first = client(accountId)
    await first.importSession(session)
    await first.destroy()

    expect((await w.t.db.select().from(accountAuth).where(eq(accountAuth.accountId, accountId))).map((r) => r.dcId)).toEqual([2])
    const raw = await w.deps.pool.query('select count(*)::int as n from mtcute.auth_keys where account = $1', [accountId])
    expect(raw.rows[0]).toEqual({ n: 0 })

    const second = client(accountId)
    try {
      const exported = readStringSession(await second.exportSession())
      expect(exported.authKey).toEqual(authKey)
      expect(exported.self?.userId).toBe(424242)
    } finally {
      await second.destroy()
    }

    await deleteAccountStorage(w.deps.pool, accountId)
    const left = await w.deps.pool.query('select count(*)::int as n from mtcute.key_value where account = $1', [accountId])
    expect(left.rows[0]).toEqual({ n: 0 })
  })
})
