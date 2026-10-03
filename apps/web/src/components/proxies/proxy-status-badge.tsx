import { proxyStatusLabels, type ProxyStatus } from '@workspace/shared/proxies'
import { Badge } from '@workspace/ui/components/badge'
import { proxyStatusVariant } from '@/lib/proxies'

export function ProxyStatusBadge({ status }: { status: ProxyStatus }) {
  return <Badge variant={proxyStatusVariant[status]}>{proxyStatusLabels[status]}</Badge>
}
