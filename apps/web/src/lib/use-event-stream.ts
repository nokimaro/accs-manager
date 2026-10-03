import * as React from 'react'
import { appEventSchema, type AppEvent } from '@workspace/shared/events'

export type StreamStatus = 'connecting' | 'open' | 'reconnecting'

/**
 * One EventSource to /api/events for the whole app. Reconnects with backoff when the browser
 * gives up (e.g. after a 401 or a deploy). Named events only; 'ready'/'ping' are keep-alives.
 */
export function useEventStream(onEvent: (event: AppEvent) => void, maxBackoffMs = 30_000): StreamStatus {
  const [status, setStatus] = React.useState<StreamStatus>('connecting')
  const onEventRef = React.useRef(onEvent)
  React.useEffect(() => {
    onEventRef.current = onEvent
  })

  React.useEffect(() => {
    let source: EventSource | null = null
    let attempt = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    let disposed = false

    const handle = (ev: MessageEvent<string>) => {
      let data: unknown
      try {
        data = JSON.parse(ev.data)
      } catch {
        return
      }
      const parsed = appEventSchema.safeParse(data)
      if (parsed.success) onEventRef.current(parsed.data)
    }

    const connect = () => {
      source = new EventSource('/api/events')
      source.addEventListener('ready', () => {
        attempt = 0
        setStatus('open')
      })
      source.onerror = () => {
        if (!source) return
        if (source.readyState === EventSource.CONNECTING) {
          setStatus('reconnecting')
          return
        }
        source.close()
        if (disposed) return
        setStatus('reconnecting')
        timer = setTimeout(connect, Math.min(maxBackoffMs, 1000 * 2 ** attempt++))
      }
      for (const type of appEventSchema.options.map((o) => o.shape.type.value)) {
        source.addEventListener(type, handle as EventListener)
      }
    }

    connect()
    return () => {
      disposed = true
      clearTimeout(timer)
      source?.close()
    }
  }, [maxBackoffMs])

  return status
}
