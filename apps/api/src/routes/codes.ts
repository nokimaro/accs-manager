import { zValidator } from '@hono/zod-validator'
import { accounts, and, codeMessages, desc, eq, sql, type SQL } from '@workspace/db'
import { codesQuery, type CodeDto } from '@workspace/shared/accounts'
import { Hono } from 'hono'
import type { AppEnv } from '../deps.ts'
import { validationHook } from './validation.ts'

export const codeRoutes = new Hono<AppEnv>().get('/codes', zValidator('query', codesQuery, validationHook), async (c) => {
  const { accountId, before, limit } = c.req.valid('query')
  const where: SQL[] = []
  if (accountId) where.push(eq(codeMessages.accountId, accountId))
  // newest by message time (history caught up later gets bigger ids but must stay below fresh codes); the cursor row decides
  if (before) where.push(sql`(${codeMessages.date}, ${codeMessages.id}) < (select c.date, c.id from ${codeMessages} c where c.id = ${before})`)
  const rows = await c
    .get('deps')
    .db.select({ code: codeMessages, account: { label: accounts.label, phone: accounts.phone, username: accounts.username } })
    .from(codeMessages)
    .innerJoin(accounts, eq(accounts.id, codeMessages.accountId))
    .where(where.length ? and(...where) : undefined)
    .orderBy(desc(codeMessages.date), desc(codeMessages.id))
    .limit(limit)
  const items: CodeDto[] = rows.map(({ code, account }) => ({
    id: code.id,
    accountId: code.accountId,
    account,
    tgMessageId: code.tgMessageId,
    date: code.date.toISOString(),
    text: code.text,
    code: code.code,
    notifiedAt: code.notifiedAt?.toISOString() ?? null,
  }))
  return c.json({ items })
})
