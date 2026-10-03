import { accounts, and, codeMessages, eq, inArray, isNull, max, ne, proxies, sql, type Db } from '@workspace/db'
import type { AccountDto, UpdateAccountInput } from '@workspace/shared/accounts'
import { DomainError } from '../lib/errors.ts'

type AccountRow = typeof accounts.$inferSelect
type ProxyRef = NonNullable<AccountDto['proxy']>

const iso = (d: Date | null) => (d ? d.toISOString() : null)

function toAccountDto(row: AccountRow, proxy: ProxyRef | null, lastCodeAt: Date | null): AccountDto {
  return {
    id: row.id,
    tgUserId: row.tgUserId,
    phone: row.phone,
    username: row.username,
    firstName: row.firstName,
    lastName: row.lastName,
    isPremium: row.isPremium,
    dcId: row.dcId,
    label: row.label,
    note: row.note,
    source: row.source,
    clientProfile: row.clientProfile,
    device: row.device,
    connectionMode: row.connectionMode,
    proxy,
    status: row.status,
    statusReason: row.statusReason,
    statusChangedAt: row.statusChangedAt.toISOString(),
    lastOkAt: iso(row.lastOkAt),
    frozenUntil: iso(row.frozenUntil),
    lastCodeAt: iso(lastCodeAt),
    createdAt: row.createdAt.toISOString(),
  }
}

function selectAccounts(db: Db) {
  const lastCodes = db.select({ accountId: codeMessages.accountId, last: max(codeMessages.date).as('last') }).from(codeMessages).groupBy(codeMessages.accountId).as('last_codes')
  return db
    .select({
      account: accounts,
      proxy: { id: proxies.id, type: proxies.type, host: proxies.host, port: proxies.port, status: proxies.status, tgCountry: proxies.tgCountry },
      lastCodeAt: lastCodes.last,
    })
    .from(accounts)
    .leftJoin(proxies, eq(proxies.id, accounts.proxyId))
    .leftJoin(lastCodes, eq(lastCodes.accountId, accounts.id))
}

type Selected = Awaited<ReturnType<ReturnType<typeof selectAccounts>['execute']>>[number]
// an aggregate in a subquery may come back as a string or a Date depending on the driver path
const asDate = (v: unknown) => (v instanceof Date ? v : v ? new Date(String(v)) : null)
const fromRow = (r: Selected) => toAccountDto(r.account, r.proxy?.id ? (r.proxy as ProxyRef) : null, asDate(r.lastCodeAt))

export async function listAccounts(db: Db): Promise<AccountDto[]> {
  return (await selectAccounts(db).orderBy(accounts.createdAt)).map(fromRow)
}

export async function getAccount(db: Db, id: string): Promise<AccountDto> {
  const [row] = await selectAccounts(db).where(eq(accounts.id, id))
  if (!row) throw new DomainError(404, 'not_found', 'Аккаунт не найден')
  return fromRow(row)
}

export async function updateAccount(db: Db, id: string, input: UpdateAccountInput): Promise<AccountDto> {
  const set: Partial<typeof accounts.$inferInsert> = {}
  if (input.label !== undefined) set.label = input.label || null
  if (input.note !== undefined) set.note = input.note || null
  if (Object.keys(set).length > 0) await db.update(accounts).set(set).where(eq(accounts.id, id))
  return getAccount(db, id)
}

/** Enabled, working (or not yet checked) and not used by another account. */
export async function isProxyFree(db: Db, proxyId: string, exceptAccountId?: string): Promise<boolean> {
  const [proxy] = await db
    .select({ id: proxies.id })
    .from(proxies)
    .leftJoin(accounts, exceptAccountId ? and(eq(accounts.proxyId, proxies.id), ne(accounts.id, exceptAccountId)) : eq(accounts.proxyId, proxies.id))
    .where(and(eq(proxies.id, proxyId), isNull(proxies.disabledAt), inArray(proxies.status, ['ok', 'unchecked', 'failing']), isNull(accounts.id)))
  return Boolean(proxy)
}

/**
 * Binds a free proxy (or none: `direct`, only by an explicit decision). A free proxy is enabled, not
 * dead/expired/provisioning and not used by another account.
 */
export async function setAccountProxy(db: Db, id: string, proxyId: string | null): Promise<AccountDto> {
  const account = await getAccount(db, id)
  if (proxyId && !(await isProxyFree(db, proxyId, id))) {
    throw new DomainError(409, 'proxy_unavailable', 'Прокси не работает, отключён или уже занят другим аккаунтом')
  }
  await db
    .update(accounts)
    .set({
      proxyId,
      connectionMode: proxyId ? 'proxy' : 'direct',
      // an account stopped because of its old proxy gets another chance with the new one
      ...(account.status === 'proxy_down' ? { status: 'pending_check' as const, statusReason: null, statusChangedAt: new Date() } : {}),
    })
    .where(eq(accounts.id, id))
  return getAccount(db, id)
}

const PAUSABLE = ['pending_check', 'active', 'proxy_down', 'frozen', 'error'] as const

export async function pauseAccount(db: Db, id: string): Promise<AccountDto> {
  const account = await getAccount(db, id)
  if (!(PAUSABLE as readonly string[]).includes(account.status)) throw new DomainError(409, 'not_pausable', 'Этот аккаунт нельзя поставить на паузу')
  await db.update(accounts).set({ status: 'paused', statusReason: null, statusChangedAt: new Date() }).where(eq(accounts.id, id))
  return getAccount(db, id)
}

export async function resumeAccount(db: Db, id: string): Promise<AccountDto> {
  const account = await getAccount(db, id)
  if (account.status !== 'paused') throw new DomainError(409, 'not_paused', 'Аккаунт не на паузе')
  await db.update(accounts).set({ status: 'pending_check', statusReason: null, statusChangedAt: new Date() }).where(eq(accounts.id, id))
  return getAccount(db, id)
}

/** The account row (auth keys and codes go with it) and everything mtcute kept for it. */
export async function deleteAccountData(db: Db, id: string): Promise<void> {
  await db.delete(accounts).where(eq(accounts.id, id))
  for (const table of ['key_value', 'auth_keys', 'temp_auth_keys', 'peers', 'message_refs']) {
    await db.execute(sql`delete from ${sql.identifier('mtcute')}.${sql.identifier(table)} where account = ${id}`).catch((err: { code?: string; cause?: { code?: string } }) => {
      // 42P01: mtcute's tables do not exist yet (the worker never ran)
      if ((err.cause?.code ?? err.code) !== '42P01') throw err
    })
  }
}
