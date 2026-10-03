import { zValidator } from '@hono/zod-validator'
import { confirmImportInput } from '@workspace/shared/accounts'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { createMiddleware } from 'hono/factory'
import { z } from 'zod'
import type { AppEnv } from '../deps.ts'
import { DomainError } from '../lib/errors.ts'
import { audited } from '../middleware/audit.ts'
import { confirmImport, createImport, getImport } from '../services/imports.ts'
import { validationHook } from './validation.ts'

const idParam = z.object({ id: z.uuid() })
const MB = 1024 * 1024
/** room for the multipart framing and the passcode field around the zip */
const MULTIPART_OVERHEAD = 64 * 1024

/** The global 1 MiB cap skips this route; here the limit follows import.maxZipSizeMb. */
const uploadLimit = createMiddleware<AppEnv>(async (c, next) =>
  bodyLimit({
    maxSize: c.get('deps').settings.get('import.maxZipSizeMb') * MB + MULTIPART_OVERHEAD,
    onError: (ctx) => ctx.json({ error: 'payload_too_large', message: `Архив больше ${ctx.get('deps').settings.get('import.maxZipSizeMb')} МБ` }, 413),
  })(c, next),
)

export const importRoutes = new Hono<AppEnv>()
  // audited first: payload null means the archive and the passcode never reach the audit log, even on a 413
  .post('/imports', audited('account.import.upload', { payload: null }), uploadLimit, async (c) => {
    const form = await c.req.parseBody()
    const file = form.file
    if (!(file instanceof File)) throw new DomainError(400, 'validation', 'Приложите zip-архив с tdata')
    const passcode = typeof form.passcode === 'string' && form.passcode !== '' ? form.passcode : undefined
    const batch = await createImport(c.get('deps'), {
      filename: file.name,
      data: new Uint8Array(await file.arrayBuffer()),
      ...(passcode ? { passcode } : {}),
      adminId: c.get('admin')?.id ?? null,
    })
    c.set('audit', { ...c.get('audit'), targetType: 'import', targetId: batch.id, payload: { filename: batch.filename, accounts: batch.items.length } })
    return c.json(batch, 201)
  })
  .get('/imports/:id', zValidator('param', idParam, validationHook), async (c) => c.json(await getImport(c.get('deps').db, c.req.valid('param').id)))
  .post(
    '/imports/:id/confirm',
    audited('account.import.confirm', { target: ['import', 'id'] }),
    zValidator('param', idParam, validationHook),
    zValidator('json', confirmImportInput, validationHook),
    async (c) => {
      const deps = c.get('deps')
      const { accountIds, ...result } = await confirmImport(deps, c.req.valid('param').id, c.req.valid('json'))
      for (const accountId of accountIds) await deps.commands.send({ type: 'account.sync', accountId })
      if (accountIds.length > 0) await deps.bus.publish({ type: 'accounts.changed', ids: accountIds })
      return c.json(result)
    },
  )
