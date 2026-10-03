import { appEventSchema, EVENTS_CHANNEL, type AppEvent } from '@workspace/shared/events'
import type { Redis } from 'ioredis'
import type { Logger } from './logger.ts'

export type EventHandler = (event: AppEvent) => unknown

export interface EventBus {
  publish(event: AppEvent): Promise<void>
  /** Returns an unsubscribe function. */
  subscribe(handler: EventHandler): () => void
  /**
   * Called each time the subscriber connection is ready again after a drop (not on the first connect).
   * Messages published during the gap are lost, so state derived from events must be re-read.
   */
  onReconnect(handler: () => void): () => void
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
        const result = handler(event)
        if (result instanceof Promise) {
          result.catch((err: unknown) => options.logger?.error({ err, type: event.type }, 'bus: handler failed'))
        }
      } catch (err) {
        options.logger?.error({ err, type: event.type }, 'bus: handler failed')
      }
    }
  }

  const reconnectHandlers = new Set<() => void>()
  const onReady = () => {
    for (const handler of reconnectHandlers) {
      try {
        handler()
      } catch (err) {
        options.logger?.error({ err }, 'bus: reconnect handler failed')
      }
    }
  }

  options.subscriber.on('message', onMessage)
  await options.subscriber.subscribe(channel)
  // registered once the first SUBSCRIBE has completed, so every later 'ready' is a reconnect
  // (ioredis re-subscribes the channel by itself before emitting it)
  options.subscriber.on('ready', onReady)

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
    onReconnect(handler) {
      reconnectHandlers.add(handler)
      return () => {
        reconnectHandlers.delete(handler)
      }
    },
    async close() {
      handlers.clear()
      reconnectHandlers.clear()
      options.subscriber.off('message', onMessage)
      options.subscriber.off('ready', onReady)
      await options.subscriber.unsubscribe(channel)
    },
  }
}
