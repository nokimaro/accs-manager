import { randomUUID } from 'node:crypto'
import { zValidator } from '@hono/zod-validator'
import { qrPasswordInput, startQrInput } from '@workspace/shared/accounts'
import { qrControlChannel, type QrControl } from '@workspace/shared/commands'
import { Hono } from 'hono'
import { z } from 'zod'
import type { AppEnv } from '../deps.ts'
import { DomainError } from '../lib/errors.ts'
import { audited } from '../middleware/audit.ts'
import { resolveProxyChoice } from '../services/accounts.ts'
import { validationHook } from './validation.ts'

const idParam = z.object({ id: z.uuid() })

/** Progress comes back as `qr.update` events on the live stream. */
export const qrRoutes = new Hono<AppEnv>()
  .post('/qr', audited('account.qr.start'), zValidator('json', startQrInput, validationHook), async (c) => {
    const { settings, db, commands } = c.get('deps')
    if (!settings.get('telegram.own.apiId') || !settings.get('telegram.own.apiHash')) {
      throw new DomainError(409, 'own_api_missing', 'Для входа по QR нужен свой api_id и api_hash (Настройки → Telegram)')
    }
    const proxyId = await resolveProxyChoice(db, c.req.valid('json').proxyId)
    const qrId = randomUUID()
    await commands.send({ type: 'qr.start', qrId, proxyId, adminId: c.get('admin')?.id ?? null })
    c.set('audit', { ...c.get('audit'), targetType: 'qr', targetId: qrId })
    return c.json({ qrId }, 201)
  })
  // the 2FA password goes straight to the worker over pub/sub: not stored, not in the audit log
  .post('/qr/:id/password', audited('account.qr.password', { payload: null, target: ['qr', 'id'] }), zValidator('param', idParam, validationHook), zValidator('json', qrPasswordInput, validationHook), async (c) => {
    const message: QrControl = { type: 'password', password: c.req.valid('json').password }
    await c.get('deps').redis.publish(qrControlChannel(c.req.valid('param').id), JSON.stringify(message))
    return c.body(null, 202)
  })
  .delete('/qr/:id', audited('account.qr.cancel', { target: ['qr', 'id'] }), zValidator('param', idParam, validationHook), async (c) => {
    const message: QrControl = { type: 'cancel' }
    await c.get('deps').redis.publish(qrControlChannel(c.req.valid('param').id), JSON.stringify(message))
    return c.body(null, 204)
  })
