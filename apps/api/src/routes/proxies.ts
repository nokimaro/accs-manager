import { zValidator } from '@hono/zod-validator'
import { createProxyInput, importProxiesInput, PROXY_STORE_STATUS_KEY, proxyStoreSyncStatus, updateProxyInput } from '@workspace/shared/proxies'
import { Hono } from 'hono'
import { z } from 'zod'
import type { AppEnv } from '../deps.ts'
import { audited } from '../middleware/audit.ts'
import { createProxy, deleteProxy, importProxies, listProxies, previewProxyImport, updateProxy } from '../services/proxies.ts'
import { validationHook } from './validation.ts'

const idParam = z.object({ id: z.uuid() })

export const proxyRoutes = new Hono<AppEnv>()
  .get('/proxies', async (c) => c.json({ items: await listProxies(c.get('deps').db) }))
  /** last proxy-store sync (null until the worker has run one) */
  .get('/proxies/sync-status', async (c) => {
    const raw = await c.get('deps').redis.get(PROXY_STORE_STATUS_KEY)
    const parsed = raw ? proxyStoreSyncStatus.safeParse(JSON.parse(raw)) : null
    return c.json({ status: parsed?.success ? parsed.data : null })
  })
  .post('/proxies', audited('proxy.create'), zValidator('json', createProxyInput, validationHook), async (c) => {
    const { db, cipher, commands, bus } = c.get('deps')
    const proxy = await createProxy(db, cipher, c.req.valid('json'))
    c.set('audit', { ...c.get('audit'), targetType: 'proxy', targetId: proxy.id })
    await commands.send({ type: 'proxy.check', proxyId: proxy.id })
    await bus.publish({ type: 'proxies.changed', ids: [proxy.id] })
    return c.json(proxy, 201)
  })
  // pasted lists carry passwords inline: the raw body never reaches the audit log
  .post('/proxies/import/preview', zValidator('json', importProxiesInput, validationHook), async (c) =>
    c.json(await previewProxyImport(c.get('deps').db, c.req.valid('json'))),
  )
  .post('/proxies/import', audited('proxy.import', { payload: null }), zValidator('json', importProxiesInput, validationHook), async (c) => {
    const { db, cipher, bus } = c.get('deps')
    const input = c.req.valid('json')
    const { ids, ...result } = await importProxies(db, cipher, input)
    c.set('audit', { ...c.get('audit'), payload: { ...result, defaultType: input.defaultType, tag: input.tag ?? null } })
    // new proxies are 'unchecked': the worker's next checkDue tick (≤ 1 min) checks them
    if (ids.length > 0) await bus.publish({ type: 'proxies.changed', ids })
    return c.json(result)
  })
  .patch('/proxies/:id', audited('proxy.update', { target: ['proxy', 'id'] }), zValidator('param', idParam, validationHook), zValidator('json', updateProxyInput, validationHook), async (c) => {
    const { db, bus } = c.get('deps')
    const proxy = await updateProxy(db, c.req.valid('param').id, c.req.valid('json'))
    await bus.publish({ type: 'proxies.changed', ids: [proxy.id] })
    return c.json(proxy)
  })
  .delete('/proxies/:id', audited('proxy.delete', { target: ['proxy', 'id'] }), zValidator('param', idParam, validationHook), async (c) => {
    const { db, bus } = c.get('deps')
    const { id } = c.req.valid('param')
    await deleteProxy(db, id)
    await bus.publish({ type: 'proxies.changed', ids: [id] })
    return c.body(null, 204)
  })
  .post('/proxies/:id/check', audited('proxy.check', { target: ['proxy', 'id'] }), zValidator('param', idParam, validationHook), async (c) => {
    await c.get('deps').commands.send({ type: 'proxy.check', proxyId: c.req.valid('param').id })
    return c.body(null, 202)
  })
  .post('/proxies/sync', audited('proxy.sync'), async (c) => {
    await c.get('deps').commands.send({ type: 'proxy.sync' })
    return c.body(null, 202)
  })
