import { z } from 'zod'

/** Redis pub/sub channel shared by api and worker; also the source of the SSE stream. */
export const EVENTS_CHANNEL = 'accs:events'

export const appEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('settings.changed'),
    keys: z.array(z.string()),
    /** admin id, or null for CLI/system */
    by: z.string().nullable(),
  }),
])

export type AppEvent = z.output<typeof appEventSchema>
export type AppEventType = AppEvent['type']
