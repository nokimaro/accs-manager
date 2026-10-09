import * as React from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import type { AccountDto, GatewayDeliveryStatus, TestCodeDto } from '@workspace/shared/accounts'
import { FINAL_STATUSES } from '@workspace/shared/accounts'
import { Button } from '@workspace/ui/components/button'
import { Spinner } from '@workspace/ui/components/spinner'
import { toast } from '@workspace/ui/components/toast'
import { SendIcon } from 'lucide-react'
import { api } from '@/lib/api'
import { settingsQueryOptions } from '@/lib/settings'

const DELIVERY: Record<GatewayDeliveryStatus, string> = {
  sent: 'отправлен',
  delivered: 'доставлен',
  read: 'прочитан',
  expired: 'истёк, не доставлен',
  revoked: 'отозван',
}
const SETTLED: readonly (GatewayDeliveryStatus | null)[] = ['delivered', 'read', 'expired', 'revoked']
/** the test message lives 5 minutes (ttl); after that its status no longer changes */
const WATCH_MS = 5 * 60_000

const credits = (n: number) => n.toLocaleString('ru-RU', { maximumFractionDigits: 4 })

/**
 * «Отправить тестовый код»: Telegram Gateway sends a code to the account's own number. It must land in
 * @VerificationCodes and show up below like any other code — a check that codes reach the account.
 */
export function TestCodePanel({ account, pollMs = 5_000 }: { account: AccountDto; pollMs?: number }) {
  const settings = useQuery(settingsQueryOptions)
  const tokenSet = settings.data?.items['gateway.token']?.isSet ?? false
  const [sent, setSent] = React.useState<{ code: TestCodeDto; at: number } | null>(null)

  const send = useMutation({
    mutationFn: () => api<TestCodeDto>(`/accounts/${account.id}/test-code`, { method: 'POST' }),
    onSuccess: (code) => setSent({ code, at: Date.now() }),
    onError: (err) => toast.add({ title: 'Тестовый код не отправлен', description: err.message }),
  })
  const status = useQuery({
    queryKey: ['accounts', account.id, 'test-code', sent?.code.requestId],
    queryFn: ({ signal }) => api<TestCodeDto>(`/accounts/${account.id}/test-code/${sent!.code.requestId}`, { signal }),
    enabled: sent !== null,
    refetchInterval: (query) => (SETTLED.includes(query.state.data?.delivery ?? null) || Date.now() - (sent?.at ?? 0) > WATCH_MS ? false : pollMs),
  })
  const delivery = status.data?.delivery ?? sent?.code.delivery ?? null
  const final = (FINAL_STATUSES as readonly string[]).includes(account.status)

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="outline" size="sm" disabled={!tokenSet || final || !account.phone || send.isPending} onClick={() => send.mutate()}>
          {send.isPending ? <Spinner data-icon="inline-start" /> : <SendIcon data-icon="inline-start" />}
          Отправить тестовый код
        </Button>
        {!tokenSet && settings.data && (
          <span className="text-muted-foreground text-sm">
            Нужен токен Telegram Gateway —{' '}
            <Link to="/settings" className="underline">
              Настройки
            </Link>
          </span>
        )}
        {sent && (
          <span className="text-sm" role="status">
            Отправлен через Telegram Gateway{sent.code.cost !== null ? ` за ${credits(sent.code.cost)}` : ''}
            {sent.code.remainingBalance ? `, на балансе ${credits(sent.code.remainingBalance)}` : ''}. Доставка:{' '}
            <span className="font-medium">{delivery ? DELIVERY[delivery] : '—'}</span>
          </span>
        )}
      </div>
      {sent && (
        <p className="text-muted-foreground text-xs">
          Код придёт в @VerificationCodes и появится в таблице ниже. «Доставлен» и «прочитан» Telegram отмечает, только пока аккаунт в сети.
        </p>
      )}
    </div>
  )
}
