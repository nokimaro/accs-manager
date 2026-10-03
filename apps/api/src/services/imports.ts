import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { writeStringSession } from '@mtcute/core/utils.js'
import { convertFromTdata, Tdata } from '@mtcute/convert'
import { accounts, importBatches, importItems, proxies, type Db } from '@workspace/db'
import type { SettingsService } from '@workspace/server'
import type { ConfirmImportInput, ImportBatchDto } from '@workspace/shared/accounts'
import type { Cipher } from '@workspace/shared/crypto'
import { parseDuration } from '@workspace/shared/duration'
import { and, eq, inArray, isNull, notInArray, sql } from '@workspace/db'
import { DomainError } from '../lib/errors.ts'
import { extractZip, ZipLimitError } from '../lib/zip.ts'

const MB = 1024 * 1024
/** TDesktop's key file: `key_` + data name + `s` (`key_datas` unless started with -key). */
const KEY_FILE_RE = /^key_([a-z0-9_]+)s$/i

export interface TdataRoot {
  dir: string
  dataKey: string
}

/** Every directory holding a key file is a tdata root; the archive may contain several, at any depth. */
export async function findTdataRoots(base: string): Promise<TdataRoot[]> {
  const roots: TdataRoot[] = []
  const entries = await readdir(base, { recursive: true, withFileTypes: true })
  for (const entry of entries) {
    const match = entry.isFile() ? KEY_FILE_RE.exec(entry.name) : null
    if (match) roots.push({ dir: entry.parentPath, dataKey: match[1]! })
  }
  return roots.sort((a, b) => a.dir.localeCompare(b.dir))
}

interface FoundAccount {
  pathInArchive: string
  accountIndex: number
  tgUserId: number
  dcId: number
  session: string
}

const isDecryptError = (err: unknown) => /decrypt|passcode|key|aes|padding|checksum|hash/i.test(err instanceof Error ? err.message : String(err))

async function readAccounts(base: string, roots: TdataRoot[], passcode: string | undefined): Promise<FoundAccount[]> {
  const found: FoundAccount[] = []
  for (const root of roots) {
    let tdata: Tdata
    try {
      tdata = await Tdata.open({ path: root.dir, dataKey: root.dataKey, ignoreVersion: true, ...(passcode ? { passcode } : {}) })
    } catch (err) {
      if (isDecryptError(err)) {
        throw passcode
          ? new DomainError(422, 'passcode_invalid', 'Неверный код-пароль Telegram Desktop')
          : new DomainError(422, 'passcode_required', 'tdata защищена локальным код-паролем — введите его')
      }
      throw new DomainError(422, 'tdata_unreadable', `Не удалось прочитать tdata: ${err instanceof Error ? err.message : String(err)}`)
    }
    for (const index of tdata.keyData.order) {
      const session = await convertFromTdata(tdata, index)
      found.push({
        pathInArchive: relative(base, root.dir) || '.',
        accountIndex: index,
        tgUserId: session.self?.userId ?? 0,
        dcId: session.primaryDcs.main.id,
        session: writeStringSession(session),
      })
    }
  }
  return found
}

export interface ImportDeps {
  db: Db
  cipher: Cipher
  settings: SettingsService
}

/**
 * Unpacks a tdata zip in a temp dir (always removed), reads every account it holds and stores an import
 * draft: encrypted sessions waiting for the admin to pick proxies and confirm. No network involved.
 */
export async function createImport(
  deps: ImportDeps,
  input: { filename: string; data: Uint8Array; passcode?: string; adminId: string | null },
): Promise<ImportBatchDto> {
  const { db, cipher, settings } = deps
  if (input.data.length > settings.get('import.maxZipSizeMb') * MB) {
    throw new DomainError(422, 'zip_too_large', `Архив больше ${settings.get('import.maxZipSizeMb')} МБ`)
  }
  const dir = await mkdtemp(join(tmpdir(), 'accs-import-'))
  try {
    try {
      extractZip(input.data, dir, { maxFiles: settings.get('import.maxFiles'), maxUnpackedBytes: settings.get('import.maxUnpackedSizeMb') * MB })
    } catch (err) {
      if (err instanceof ZipLimitError) throw new DomainError(422, `zip_${err.kind}`, err.message)
      throw new DomainError(422, 'zip_invalid', 'Не удалось распаковать архив — это точно zip?')
    }
    const roots = await findTdataRoots(dir)
    if (roots.length === 0) throw new DomainError(422, 'tdata_not_found', 'В архиве нет tdata (не найден файл key_datas)')
    const found = await readAccounts(dir, roots, input.passcode)
    if (found.length === 0) throw new DomainError(422, 'tdata_empty', 'В tdata нет аккаунтов')

    const existing = await db
      .select({ id: accounts.id, tgUserId: accounts.tgUserId })
      .from(accounts)
      .where(inArray(accounts.tgUserId, found.map((f) => f.tgUserId)))
    const byUser = new Map(existing.map((a) => [a.tgUserId, a.id]))

    const expiresAt = new Date(Date.now() + parseDuration(settings.get('import.draftTtl')))
    const batchId = await db.transaction(async (tx) => {
      const [batch] = await tx.insert(importBatches).values({ adminId: input.adminId, filename: input.filename.slice(0, 255), expiresAt }).returning({ id: importBatches.id })
      await tx.insert(importItems).values(
        found.map((f) => ({
          batchId: batch!.id,
          pathInArchive: f.pathInArchive,
          accountIndex: f.accountIndex,
          tgUserId: f.tgUserId,
          dcId: f.dcId,
          sessionEnc: cipher.encrypt(f.session),
          duplicateOf: byUser.get(f.tgUserId) ?? null,
        })),
      )
      return batch!.id
    })
    return getImport(db, batchId)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

export async function getImport(db: Db, id: string): Promise<ImportBatchDto> {
  const [batch] = await db.select().from(importBatches).where(eq(importBatches.id, id))
  if (!batch) throw new DomainError(404, 'not_found', 'Импорт не найден или истёк')
  const items = await db
    .select({
      item: importItems,
      dup: { id: accounts.id, label: accounts.label, phone: accounts.phone },
    })
    .from(importItems)
    .leftJoin(accounts, eq(accounts.id, importItems.duplicateOf))
    .where(eq(importItems.batchId, id))
    .orderBy(importItems.pathInArchive, importItems.accountIndex)
  return {
    id: batch.id,
    filename: batch.filename,
    status: batch.status,
    createdAt: batch.createdAt.toISOString(),
    expiresAt: batch.expiresAt.toISOString(),
    items: items.map(({ item, dup }) => ({
      id: item.id,
      pathInArchive: item.pathInArchive,
      accountIndex: item.accountIndex,
      tgUserId: item.tgUserId,
      dcId: item.dcId,
      duplicateOf: dup?.id ? dup : null,
      decision: item.decision,
      accountId: item.accountId,
    })),
  }
}

/**
 * Free proxies, by the same rule as the account card and QR (`isProxyFree`): enabled, not bound, and working,
 * not yet checked or only failing. Working ones first, then by latency — «auto» takes from the front.
 */
async function freeProxyIds(db: Db, exclude: string[]): Promise<string[]> {
  const rows = await db
    .select({ id: proxies.id })
    .from(proxies)
    .leftJoin(accounts, eq(accounts.proxyId, proxies.id))
    .where(
      and(
        inArray(proxies.status, ['ok', 'unchecked', 'failing']),
        isNull(proxies.disabledAt),
        isNull(accounts.id),
        ...(exclude.length ? [notInArray(proxies.id, exclude)] : []),
      ),
    )
    .orderBy(sql`${proxies.status} <> 'ok'`, sql`${proxies.latencyMs} nulls last`)
  return rows.map((r) => r.id)
}

export async function confirmImport(
  deps: ImportDeps,
  batchId: string,
  input: ConfirmImportInput,
): Promise<{ created: number; skipped: number; accountIds: string[] }> {
  const { db, settings } = deps
  const batch = await getImport(db, batchId)
  if (batch.status !== 'ready') throw new DomainError(409, 'already_confirmed', 'Этот импорт уже подтверждён')
  if (new Date(batch.expiresAt) < new Date()) throw new DomainError(409, 'expired', 'Импорт истёк — загрузите архив заново')

  const items = new Map(batch.items.map((i) => [i.id, i]))
  const device = {
    deviceModel: settings.get('telegram.desktop.deviceModel'),
    systemVersion: settings.get('telegram.desktop.systemVersion'),
    appVersion: settings.get('telegram.desktop.appVersion'),
    langCode: settings.get('telegram.desktop.langCode'),
  }
  const chosen = input.items.flatMap((d) => (d.decision === 'proxy' ? [d.proxyId] : []))
  const free = new Set(await freeProxyIds(db, []))
  for (const id of chosen) if (!free.has(id)) throw new DomainError(409, 'proxy_unavailable', 'Выбранный прокси не работает, отключён или уже занят')
  if (new Set(chosen).size !== chosen.length) throw new DomainError(409, 'proxy_unavailable', 'Один прокси выбран для двух аккаунтов')
  const autoPool = (await freeProxyIds(db, chosen)).reverse()

  const result = { created: 0, skipped: 0, accountIds: [] as string[] }
  await db.transaction(async (tx) => {
    for (const decision of input.items) {
      const item = items.get(decision.id)
      if (!item) throw new DomainError(400, 'unknown_item', 'Аккаунт не из этого импорта')
      if (decision.decision === 'skip') {
        await tx.update(importItems).set({ decision: 'skipped' }).where(eq(importItems.id, item.id))
        result.skipped++
        continue
      }
      if (item.duplicateOf) throw new DomainError(409, 'duplicate', `Аккаунт ${item.tgUserId} уже в панели — его можно только пропустить`)
      let proxyId: string | null = null
      if (decision.decision === 'proxy') proxyId = decision.proxyId
      if (decision.decision === 'auto') {
        proxyId = autoPool.pop() ?? null
        if (!proxyId) throw new DomainError(409, 'no_free_proxy', 'Свободных рабочих прокси не хватает на все аккаунты')
      }
      const [row] = await tx.select({ sessionEnc: importItems.sessionEnc }).from(importItems).where(eq(importItems.id, item.id))
      const [account] = await tx
        .insert(accounts)
        .values({
          tgUserId: item.tgUserId,
          dcId: item.dcId,
          source: 'tdata',
          clientProfile: 'desktop',
          device,
          connectionMode: proxyId ? 'proxy' : 'direct',
          proxyId,
          status: 'pending_check',
          sessionImportEnc: row!.sessionEnc,
        })
        .returning({ id: accounts.id })
      await tx.update(importItems).set({ decision: 'imported', accountId: account!.id }).where(eq(importItems.id, item.id))
      result.created++
      result.accountIds.push(account!.id)
    }
    await tx.update(importBatches).set({ status: 'confirmed' }).where(eq(importBatches.id, batchId))
  })
  return result
}
