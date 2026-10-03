import * as React from 'react'
import { appEventSchema, type AppEvent } from '@workspace/shared/events'

export type StreamStatus = 'connecting' | 'open' | 'reconnecting'

export interface EventStreamHandlers {
  onEvent: (event: AppEvent) => void
  /** The server ended the stream with `unauthorized`, or the connection failed: the session may be gone. */
  onSessionLost?: () => void
  /** The stream is open again after a drop; events sent in between were missed. */
  onReconnect?: () => void
}

/**
 * One EventSource to /api/events for the whole app. Reconnects with backoff when the browser
 * gives up (e.g. after a 401 or a deploy). Named events only; 'ready'/'ping' are keep-alives.
 */
export function useEventStream(handlers: EventStreamHandlers, maxBackoffMs = 30_000): StreamStatus {
  const [status, setStatus] = React.useState<StreamStatus>('connecting')
  const handlersRef = React.useRef(handlers)
  React.useEffect(() => {
    handlersRef.current = handlers
  })

  React.useEffect(() => {
    let source: EventSource | null = null
    let attempt = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    let disposed = false
    let interrupted = false

    const handle = (ev: MessageEvent<string>) => {
      let data: unknown
      try {
        data = JSON.parse(ev.data)
      } catch {
        return
      }
      const parsed = appEventSchema.safeParse(data)
      if (parsed.success) handlersRef.current.onEvent(parsed.data)
    }

    const reconnectLater = () => {
      source?.close()
      if (disposed) return
      setStatus('reconnecting')
      timer = setTimeout(connect, Math.min(maxBackoffMs, 1000 * 2 ** attempt++))
    }

    const connect = () => {
      source = new EventSource('/api/events')
      source.addEventListener('ready', () => {
        attempt = 0
        setStatus('open')
        if (interrupted) handlersRef.current.onReconnect?.()
        interrupted = false
      })
      source.addEventListener('unauthorized', () => {
        interrupted = true
        reconnectLater()
        handlersRef.current.onSessionLost?.()
      })
      source.onerror = () => {
        if (!source) return
        interrupted = true
        handlersRef.current.onSessionLost?.()
        if (source.readyState === EventSource.CONNECTING) {
          setStatus('reconnecting')
          return
        }
        reconnectLater()
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
