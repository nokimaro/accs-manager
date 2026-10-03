import { zValidator } from '@hono/zod-validator'
import { settingsPatchInput, type SettingsResponse } from '@workspace/shared/api'
import { Hono } from 'hono'
import type { AppEnv } from '../deps.ts'
import { audited } from '../middleware/audit.ts'
import { validationHook } from './validation.ts'

export const settingsRoutes = new Hono<AppEnv>()
  .get('/settings', (c) => c.json({ items: c.get('deps').settings.snapshot() } satisfies SettingsResponse))
  // the raw body may carry secret values — audit records keys / the redacted diff instead
  .patch('/settings', audited('settings.update', { payload: null }), zValidator('json', settingsPatchInput, validationHook), async (c) => {
    const { settings } = c.get('deps')
    const { changes } = c.req.valid('json')
    c.set('audit', { ...c.get('audit'), payload: { keys: Object.keys(changes) } })
    const result = await settings.update(changes, { adminId: c.get('admin')!.id })
    if (!result.ok) return c.json({ error: 'validation', fields: result.errors }, 400)
    c.set('audit', { ...c.get('audit'), payload: { diff: result.diff } })
    return c.json({ items: settings.snapshot() } satisfies SettingsResponse)
  })
