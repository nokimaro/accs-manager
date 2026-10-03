import type { IAuthKeysRepository, ITelegramStorageProvider } from '@mtcute/core'
import { TelegramClient } from '@mtcute/node'
import { PostgresStorage } from '@mtcute/postgres'
import { accountAuth, and, eq, type Db } from '@workspace/db'
import type { Cipher } from '@workspace/shared/crypto'
import type pg from 'pg'

/** Schema of @mtcute/postgres' own tables (peers cache, update state); drizzle never touches it. */
export const MTCUTE_SCHEMA = 'mtcute'
const MTCUTE_TABLES = ['key_value', 'auth_keys', 'temp_auth_keys', 'peers', 'message_refs'] as const

/**
 * Auth keys of one account, encrypted with APP_ENCRYPTION_KEY in `account_auth` — never in clear text
 * (@mtcute/postgres would store them raw). Temporary PFS keys are not used.
 */
export class EncryptedAuthKeys implements IAuthKeysRepository {
  readonly #db: Db
  readonly #cipher: Cipher
  readonly #accountId: string

  constructor(db: Db, cipher: Cipher, accountId: string) {
    this.#db = db
    this.#cipher = cipher
    this.#accountId = accountId
  }

  async set(dc: number, key: Uint8Array | null): Promise<void> {
    if (key === null) return this.deleteByDc(dc)
    const authKeyEnc = this.#cipher.encrypt(Buffer.from(key).toString('base64'))
    await this.#db
      .insert(accountAuth)
      .values({ accountId: this.#accountId, dcId: dc, authKeyEnc })
      .onConflictDoUpdate({ target: [accountAuth.accountId, accountAuth.dcId], set: { authKeyEnc, updatedAt: new Date() } })
  }

  async get(dc: number): Promise<Uint8Array | null> {
    const [row] = await this.#db
      .select({ authKeyEnc: accountAuth.authKeyEnc })
      .from(accountAuth)
      .where(and(eq(accountAuth.accountId, this.#accountId), eq(accountAuth.dcId, dc)))
    return row ? new Uint8Array(Buffer.from(this.#cipher.decrypt(row.authKeyEnc), 'base64')) : null
  }

  setTemp(): void {}

  getTemp(): null {
    return null
  }

  async deleteByDc(dc: number): Promise<void> {
    await this.#db.delete(accountAuth).where(and(eq(accountAuth.accountId, this.#accountId), eq(accountAuth.dcId, dc)))
  }

  async deleteAll(): Promise<void> {
    await this.#db.delete(accountAuth).where(eq(accountAuth.accountId, this.#accountId))
  }
}

/** mtcute storage of one account: everything from @mtcute/postgres except the auth keys. */
export function createAccountStorage(pool: pg.Pool, db: Db, cipher: Cipher, accountId: string): ITelegramStorageProvider {
  const pg = new PostgresStorage(pool, { schema: MTCUTE_SCHEMA, account: accountId })
  return { driver: pg.driver, kv: pg.kv, peers: pg.peers, refMessages: pg.refMessages, authKeys: new EncryptedAuthKeys(db, cipher, accountId) }
}

/**
 * Runs @mtcute/postgres migrations once at worker start, so that dozens of accounts loading at the same
 * time do not race on `create table`. No network: prepare() only loads the storage.
 */
export async function prepareMtcuteStorage(pool: pg.Pool, db: Db, cipher: Cipher): Promise<void> {
  const client = new TelegramClient({ apiId: 1, apiHash: '0', storage: createAccountStorage(pool, db, cipher, '__bootstrap__'), logLevel: 0 })
  try {
    await client.prepare()
  } finally {
    await client.destroy()
  }
}

/** Forgets everything mtcute kept for the account (auth keys go with `account_auth` rows). */
export async function deleteAccountStorage(pool: pg.Pool, accountId: string): Promise<void> {
  for (const table of MTCUTE_TABLES) {
    await pool.query(`delete from "${MTCUTE_SCHEMA}"."${table}" where account = $1`, [accountId]).catch((err: { code?: string }) => {
      // 42P01: the table does not exist (storage never prepared)
      if (err.code !== '42P01') throw err
    })
  }
}
