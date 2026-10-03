import { appEventSchema, EVENTS_CHANNEL, type AppEvent } from '@workspace/shared/events'
import type { Redis } from 'ioredis'
import type { Logger } from './logger.ts'

export type EventHandler = (event: AppEvent) => void

export interface EventBus {
  publish(event: AppEvent): Promise<void>
  /** Returns an unsubscribe function. */
  subscribe(handler: EventHandler): () => void
  close(): Promise<void>
}

/**
 * Typed pub/sub over one Redis channel. `subscriber` must be a dedicated connection
 * (a subscribed ioredis client cannot run other commands). Connections are owned by the caller.
 */
export async function createEventBus(options: {
  publisher: Redis
  subscriber: Redis
  channel?: string
  logger?: Logger
}): Promise<EventBus> {
  const channel = options.channel ?? EVENTS_CHANNEL
  const handlers = new Set<EventHandler>()

  const onMessage = (ch: string, raw: string) => {
    if (ch !== channel) return
    let event: AppEvent
    try {
      const parsed = appEventSchema.safeParse(JSON.parse(raw))
      if (!parsed.success) {
        options.logger?.warn({ raw }, 'bus: dropping invalid event')
        return
      }
      event = parsed.data
    } catch {
      options.logger?.warn({ raw }, 'bus: dropping non-JSON message')
      return
    }
    for (const handler of handlers) {
      try {
        handler(event)
      } catch (err) {
        options.logger?.error({ err, type: event.type }, 'bus: handler failed')
      }
    }
  }

  options.subscriber.on('message', onMessage)
  await options.subscriber.subscribe(channel)

  return {
    async publish(event) {
      await options.publisher.publish(channel, JSON.stringify(appEventSchema.parse(event)))
    },
    subscribe(handler) {
      handlers.add(handler)
      return () => {
        handlers.delete(handler)
      }
    },
    async close() {
      handlers.clear()
      options.subscriber.off('message', onMessage)
      await options.subscriber.unsubscribe(channel)
    },
  }
}
