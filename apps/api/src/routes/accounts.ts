import { zValidator } from '@hono/zod-validator'
import { deleteAccountQuery, setAccountProxyInput, updateAccountInput } from '@workspace/shared/accounts'
import type { AccountSessionsResult, AccountStopResult, TerminateSessionResult } from '@workspace/shared/commands'
import { Hono } from 'hono'
import { z } from 'zod'
import type { AppEnv } from '../deps.ts'
import { DomainError } from '../lib/errors.ts'
import { audited } from '../middleware/audit.ts'
import { deleteAccountData, getAccount, listAccounts, pauseAccount, resumeAccount, setAccountProxy, updateAccount } from '../services/accounts.ts'
import { validationHook } from './validation.ts'

const idParam = z.object({ id: z.uuid() })
const sessionParam = z.object({ id: z.uuid(), hash: z.string().regex(/^-?\d+$/) })
const NOT_RUNNING = new DomainError(409, 'not_running', 'Аккаунт сейчас не подключён к Telegram')

export const accountRoutes = new Hono<AppEnv>()
  .get('/accounts', async (c) => c.json({ items: await listAccounts(c.get('deps').db) }))
  .get('/accounts/:id', zValidator('param', idParam, validationHook), async (c) => c.json(await getAccount(c.get('deps').db, c.req.valid('param').id)))
  .patch('/accounts/:id', audited('account.update', { target: ['account', 'id'] }), zValidator('param', idParam, validationHook), zValidator('json', updateAccountInput, validationHook), async (c) => {
    const { db, bus } = c.get('deps')
    const account = await updateAccount(db, c.req.valid('param').id, c.req.valid('json'))
    await bus.publish({ type: 'accounts.changed', ids: [account.id] })
    return c.json(account)
  })
  .put('/accounts/:id/proxy', audited('account.proxy', { target: ['account', 'id'] }), zValidator('param', idParam, validationHook), zValidator('json', setAccountProxyInput, validationHook), async (c) => {
    const { db, bus, commands } = c.get('deps')
    const account = await setAccountProxy(db, c.req.valid('param').id, c.req.valid('json').proxyId)
    // reconnect through the new route (or start an account that was waiting for a working proxy)
    await commands.send({ type: 'account.sync', accountId: account.id })
    await bus.publish({ type: 'accounts.changed', ids: [account.id] })
    await bus.publish({ type: 'proxies.changed', ids: [] })
    return c.json(account)
  })
  .post('/accounts/:id/pause', audited('account.pause', { target: ['account', 'id'] }), zValidator('param', idParam, validationHook), async (c) => {
    const { db, bus, commands } = c.get('deps')
    const account = await pauseAccount(db, c.req.valid('param').id)
    await commands.send({ type: 'account.stop', accountId: account.id, logout: false })
    await bus.publish({ type: 'accounts.changed', ids: [account.id] })
    return c.json(account)
  })
  .post('/accounts/:id/resume', audited('account.resume', { target: ['account', 'id'] }), zValidator('param', idParam, validationHook), async (c) => {
    const { db, bus, commands } = c.get('deps')
    const account = await resumeAccount(db, c.req.valid('param').id)
    await commands.send({ type: 'account.sync', accountId: account.id })
    await bus.publish({ type: 'accounts.changed', ids: [account.id] })
    return c.json(account)
  })
  .post('/accounts/:id/reconnect', audited('account.reconnect', { target: ['account', 'id'] }), zValidator('param', idParam, validationHook), async (c) => {
    const { db, commands } = c.get('deps')
    const account = await getAccount(db, c.req.valid('param').id)
    await commands.send({ type: 'account.sync', accountId: account.id })
    return c.body(null, 202)
  })
  .delete('/accounts/:id', audited('account.delete', { target: ['account', 'id'] }), zValidator('param', idParam, validationHook), zValidator('query', deleteAccountQuery, validationHook), async (c) => {
    const { db, bus, commands } = c.get('deps')
    const { id } = c.req.valid('param')
    const { logout } = c.req.valid('query')
    await getAccount(db, id)
    // the worker drops the client first (and ends the Telegram session if asked) — then the data goes
    const result = await commands.call<AccountStopResult>({ type: 'account.stop', accountId: id, logout }, 30_000)
    if (logout && !result.loggedOut) {
      throw new DomainError(409, 'logout_failed', 'Не удалось завершить сессию в Telegram (аккаунт не подключён?) — удалите без выхода')
    }
    await deleteAccountData(db, id)
    await bus.publish({ type: 'accounts.changed', ids: [id] })
    return c.body(null, 204)
  })
  // the list of the owner's devices is sensitive: reading it is audited too
  .get('/accounts/:id/sessions', audited('account.sessions.read', { target: ['account', 'id'] }), zValidator('param', idParam, validationHook), async (c) => {
    const result = await c.get('deps').commands.call<AccountSessionsResult>({ type: 'account.sessions', accountId: c.req.valid('param').id })
    if ('error' in result) throw NOT_RUNNING
    return c.json({ items: result.sessions })
  })
  .delete('/accounts/:id/sessions/:hash', audited('account.session.terminate', { target: ['account', 'id'] }), zValidator('param', sessionParam, validationHook), async (c) => {
    const { id, hash } = c.req.valid('param')
    const result = await c.get('deps').commands.call<TerminateSessionResult>({ type: 'account.terminateSession', accountId: id, hash })
    if ('error' in result) throw NOT_RUNNING
    return c.body(null, 204)
  })
