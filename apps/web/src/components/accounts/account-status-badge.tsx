import { accountStatusLabels, type AccountStatus } from '@workspace/shared/accounts'
import { Badge } from '@workspace/ui/components/badge'
import { Tooltip, TooltipContent, TooltipTrigger } from '@workspace/ui/components/tooltip'
import { accountStatusVariant } from '@/lib/accounts'

export function AccountStatusBadge({ status, reason }: { status: AccountStatus; reason?: string | null }) {
  const badge = <Badge variant={accountStatusVariant[status]}>{accountStatusLabels[status]}</Badge>
  if (!reason) return badge
  return (
    <Tooltip>
      <TooltipTrigger render={<span />}>{badge}</TooltipTrigger>
      <TooltipContent>{reason}</TooltipContent>
    </Tooltip>
  )
}
