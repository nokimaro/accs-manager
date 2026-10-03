import * as React from 'react'
import type { AppEvent } from '@workspace/shared/events'

const EVENT_NAME = 'accs:event'

/** Re-broadcasts live-stream events inside the page, for components that care about one kind (QR login). */
export function emitAppEvent(event: AppEvent): void {
  window.dispatchEvent(new CustomEvent<AppEvent>(EVENT_NAME, { detail: event }))
}

export function useAppEvent(handler: (event: AppEvent) => void): void {
  const ref = React.useRef(handler)
  React.useEffect(() => {
    ref.current = handler
  })
  React.useEffect(() => {
    const listener = (e: Event) => ref.current((e as CustomEvent<AppEvent>).detail)
    window.addEventListener(EVENT_NAME, listener)
    return () => window.removeEventListener(EVENT_NAME, listener)
  }, [])
}
