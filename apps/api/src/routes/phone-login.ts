import { randomUUID } from 'node:crypto'
import { zValidator } from '@hono/zod-validator'
import { phoneCodeInput, qrPasswordInput, startPhoneLoginInput } from '@workspace/shared/accounts'
import { loginControlChannel, type LoginControl } from '@workspace/shared/commands'
import { Hono } from 'hono'
import { z } from 'zod'
import type { AppEnv } from '../deps.ts'
import { DomainError } from '../lib/errors.ts'
import { audited } from '../middleware/audit.ts'
import { isProxyFree } from '../services/accounts.ts'
import { validationHook } from './validation.ts'

const idParam = z.object({ id: z.uuid() })

/** Progress comes back as `phone.update` events on the live stream. */
export const phoneLoginRoutes = new Hono<AppEnv>()
  .post('/phone-login', audited('account.phone.start'), zValidator('json', startPhoneLoginInput, validationHook), async (c) => {
    const { settings, db, commands } = c.get('deps')
    if (!settings.get('telegram.own.apiId') || !settings.get('telegram.own.apiHash')) {
      throw new DomainError(409, 'own_api_missing', 'Для входа по номеру нужен свой api_id и api_hash (Настройки → Telegram)')
    }
    const { phone, proxyId } = c.req.valid('json')
    if (proxyId && !(await isProxyFree(db, proxyId))) throw new DomainError(409, 'proxy_unavailable', 'Прокси не работает, отключён или уже занят')
    const loginId = randomUUID()
    await commands.send({ type: 'phone.start', loginId, phone, proxyId, adminId: c.get('admin')?.id ?? null })
    c.set('audit', { ...c.get('audit'), targetType: 'phone_login', targetId: loginId })
    return c.json({ loginId }, 201)
  })
  // the code and the cloud password go straight to the worker over pub/sub: not stored, not in the audit log
  .post('/phone-login/:id/code', audited('account.phone.code', { payload: null, target: ['phone_login', 'id'] }), zValidator('param', idParam, validationHook), zValidator('json', phoneCodeInput, validationHook), async (c) => {
    await publish(c, c.req.valid('param').id, { type: 'code', code: c.req.valid('json').code })
    return c.body(null, 202)
  })
  .post('/phone-login/:id/password', audited('account.phone.password', { payload: null, target: ['phone_login', 'id'] }), zValidator('param', idParam, validationHook), zValidator('json', qrPasswordInput, validationHook), async (c) => {
    await publish(c, c.req.valid('param').id, { type: 'password', password: c.req.valid('json').password })
    return c.body(null, 202)
  })
  .post('/phone-login/:id/resend', audited('account.phone.resend', { target: ['phone_login', 'id'] }), zValidator('param', idParam, validationHook), async (c) => {
    await publish(c, c.req.valid('param').id, { type: 'resend' })
    return c.body(null, 202)
  })
  .delete('/phone-login/:id', audited('account.phone.cancel', { target: ['phone_login', 'id'] }), zValidator('param', idParam, validationHook), async (c) => {
    await publish(c, c.req.valid('param').id, { type: 'cancel' })
    return c.body(null, 204)
  })

async function publish(c: { get: (key: 'deps') => AppEnv['Variables']['deps'] }, loginId: string, message: LoginControl): Promise<void> {
  await c.get('deps').redis.publish(loginControlChannel(loginId), JSON.stringify(message))
}
