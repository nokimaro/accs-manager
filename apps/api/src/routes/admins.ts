import { zValidator } from '@hono/zod-validator'
import { createAdminInput, resetPasswordInput } from '@workspace/shared/api'
import { Hono } from 'hono'
import { z } from 'zod'
import type { AppEnv } from '../deps.ts'
import { audited } from '../middleware/audit.ts'
import { createAdmin, disableAdmin, listAdmins, setAdminPassword } from '../services/admins.ts'
import { validationHook } from './validation.ts'

const idParam = z.object({ id: z.uuid() })

export const adminRoutes = new Hono<AppEnv>()
  .get('/admins', async (c) => c.json({ items: await listAdmins(c.get('deps').db) }))
  .post('/admins', audited('admin.create'), zValidator('json', createAdminInput, validationHook), async (c) => {
    const admin = await createAdmin(c.get('deps').db, c.req.valid('json'))
    c.set('audit', { ...c.get('audit'), targetType: 'admin', targetId: admin.id })
    return c.json(admin, 201)
  })
  .post('/admins/:id/disable', audited('admin.disable', { target: ['admin', 'id'] }), zValidator('param', idParam, validationHook), async (c) =>
    c.json(await disableAdmin(c.get('deps').db, c.req.valid('param').id)),
  )
  .post(
    '/admins/:id/reset-password',
    audited('admin.password.reset', { target: ['admin', 'id'] }),
    zValidator('param', idParam, validationHook),
    zValidator('json', resetPasswordInput, validationHook),
    async (c) => {
      await setAdminPassword(c.get('deps').db, c.req.valid('param').id, c.req.valid('json').password)
      return c.body(null, 204)
    },
  )
