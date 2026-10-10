import { cn } from '@workspace/ui/lib/utils'
import { formatDateTime, formatRelative } from '@/lib/format'

/** «5 минут назад», muted, the exact date and time on hover — the one look of relative times in tables. */
export function TimeAgo({ iso, className }: { iso: string | null | undefined; className?: string }) {
  return (
    <span title={formatDateTime(iso)} className={cn('text-muted-foreground whitespace-nowrap', className)}>
      {formatRelative(iso)}
    </span>
  )
}
