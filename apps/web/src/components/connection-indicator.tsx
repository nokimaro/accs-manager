import { Badge } from '@workspace/ui/components/badge'
import type { StreamStatus } from '@/lib/use-event-stream'

const LABELS: Record<StreamStatus, string> = { open: 'Онлайн', connecting: 'Подключение…', reconnecting: 'Нет связи' }

export function ConnectionIndicator({ status }: { status: StreamStatus }) {
  return (
    <Badge variant={status === 'open' ? 'secondary' : 'destructive'} aria-live="polite" title="Живые обновления">
      {LABELS[status]}
    </Badge>
  )
}
