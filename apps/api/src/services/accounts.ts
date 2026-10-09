import { accounts, and, codeMessages, count, desc, eq, inArray, isNull, ne, proxies, sql, type Db } from '@workspace/db'
import { REUSE_PROXY, type AccountDto, type UpdateAccountInput } from '@workspace/shared/accounts'
import { DomainError } from '../lib/errors.ts'

type AccountRow = typeof accounts.$inferSelect
type ProxyRef = NonNullable<AccountDto['proxy']>

const iso = (d: Date | null) => (d ? d.toISOString() : null)

function toAccountDto(row: AccountRow, proxy: ProxyRef | null, last: { code: string | null; at: Date | null }): AccountDto {
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
    lastCode: last.code,
    lastCodeAt: iso(last.at),
    createdAt: row.createdAt.toISOString(),
  }
}

function selectAccounts(db: Db) {
  // the latest message per account: its code and time
  const lastCodes = db
    .selectDistinctOn([codeMessages.accountId], { accountId: codeMessages.accountId, last: codeMessages.date, lastCode: codeMessages.code })
    .from(codeMessages)
    .orderBy(codeMessages.accountId, desc(codeMessages.date), desc(codeMessages.id))
    .as('last_codes')
  return db
    .select({
      account: accounts,
      proxy: { id: proxies.id, type: proxies.type, host: proxies.host, port: proxies.port, status: proxies.status, tgCountry: proxies.tgCountry },
      lastCodeAt: lastCodes.last,
      lastCode: lastCodes.lastCode,
    })
    .from(accounts)
    .leftJoin(proxies, eq(proxies.id, accounts.proxyId))
    .leftJoin(lastCodes, eq(lastCodes.accountId, accounts.id))
}

type Selected = Awaited<ReturnType<ReturnType<typeof selectAccounts>['execute']>>[number]
// an aggregate in a subquery may come back as a string or a Date depending on the driver path
const asDate = (v: unknown) => (v instanceof Date ? v : v ? new Date(String(v)) : null)
const fromRow = (r: Selected) => toAccountDto(r.account, r.proxy?.id ? (r.proxy as ProxyRef) : null, { code: r.lastCode ?? null, at: asDate(r.lastCodeAt) })

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

const USABLE_PROXY_STATUSES = ['ok', 'unchecked', 'failing'] as const

/** Enabled and working, not yet checked or only failing. Any number of accounts may share it. */
export async function isProxyUsable(db: Db, proxyId: string): Promise<boolean> {
  const [proxy] = await db
    .select({ id: proxies.id })
    .from(proxies)
    .where(and(eq(proxies.id, proxyId), isNull(proxies.disabledAt), inArray(proxies.status, [...USABLE_PROXY_STATUSES])))
  return Boolean(proxy)
}

/** Usable proxies and how many accounts each carries (`exceptAccountId` is not counted: it is about to move). */
export async function proxyLoads(db: Db, exceptAccountId?: string): Promise<Map<string, number>> {
  const rows = await db
    .select({ id: proxies.id, accounts: count(accounts.id) })
    .from(proxies)
    .leftJoin(accounts, exceptAccountId ? and(eq(accounts.proxyId, proxies.id), ne(accounts.id, exceptAccountId)) : eq(accounts.proxyId, proxies.id))
    .where(and(isNull(proxies.disabledAt), inArray(proxies.status, [...USABLE_PROXY_STATUSES])))
    .groupBy(proxies.id)
  return new Map(rows.map((r) => [r.id, r.accounts]))
}

/**
 * «Переиспользовать прокси»: the proxy with the fewest accounts, a random one among equals. The pick is counted
 * in `loads`, so several picks in a row spread evenly. Null when there is no usable proxy at all.
 */
export function takeLeastLoaded(loads: Map<string, number>, random: () => number = Math.random): string | null {
  let min = Infinity
  let ties: string[] = []
  for (const [id, n] of loads) {
    if (n < min) [min, ties] = [n, [id]]
    else if (n === min) ties.push(id)
  }
  const id = ties[Math.floor(random() * ties.length)]
  if (id === undefined) return null
  loads.set(id, min + 1)
  return id
}

/** A proxy choice from the UI (`reuse`, a proxy id, or null = direct) made concrete, or a 409 saying why it cannot be. */
export async function resolveProxyChoice(db: Db, choice: string | null, exceptAccountId?: string): Promise<string | null> {
  if (choice === null) return null
  if (choice === REUSE_PROXY) {
    const id = takeLeastLoaded(await proxyLoads(db, exceptAccountId))
    if (!id) throw new DomainError(409, 'no_usable_proxy', 'Нет ни одного рабочего прокси — добавьте прокси или выберите «Напрямую»')
    return id
  }
  if (!(await isProxyUsable(db, choice))) throw new DomainError(409, 'proxy_unavailable', 'Прокси не работает или отключён')
  return choice
}

/** Binds a proxy (`reuse` = the least loaded one), or none: `direct`, only by an explicit decision. */
export async function setAccountProxy(db: Db, id: string, choice: string | null): Promise<AccountDto> {
  const account = await getAccount(db, id)
  const proxyId = await resolveProxyChoice(db, choice, id)
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
