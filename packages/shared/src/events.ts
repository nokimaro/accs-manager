import { z } from 'zod'
import { QR_STATES } from './accounts.ts'

/** Redis pub/sub channel shared by api and worker; also the source of the SSE stream. */
export const EVENTS_CHANNEL = 'accs:events'

export const appEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('settings.changed'),
    keys: z.array(z.string()),
    /** admin id, or null for CLI/system */
    by: z.string().nullable(),
  }),
  /** proxies added, removed, checked or synced — the UI refetches */
  z.object({ type: z.literal('proxies.changed'), ids: z.array(z.string()) }),
  /** account status, profile or proxy changed — the UI refetches */
  z.object({ type: z.literal('accounts.changed'), ids: z.array(z.string()) }),
  z.object({
    type: z.literal('code.new'),
    id: z.number(),
    accountId: z.string(),
    code: z.string().nullable(),
    date: z.string(),
  }),
  /** progress of a QR login started in the panel */
  z.object({
    type: z.literal('qr.update'),
    qrId: z.string(),
    state: z.enum(QR_STATES),
    url: z.string().optional(),
    expiresAt: z.string().optional(),
    hint: z.string().optional(),
    accountId: z.string().optional(),
    message: z.string().optional(),
  }),
])

export type AppEvent = z.output<typeof appEventSchema>
export type AppEventType = AppEvent['type']
