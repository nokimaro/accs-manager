import * as React from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { AccountDto } from '@workspace/shared/accounts'
import { Button } from '@workspace/ui/components/button'
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from '@workspace/ui/components/field'
import { toast } from '@workspace/ui/components/toast'
import { accountQueryOptions, accountsQueryOptions, freeProxies } from '@/lib/accounts'
import { api } from '@/lib/api'
import { proxiesQueryOptions } from '@/lib/proxies'
import { RouteSelect, type RouteChoice } from './route-select'

const DIRECT = 'direct'

function currentRoute(a: AccountDto): RouteChoice | null {
  return a.proxy?.id ?? (a.connectionMode === 'direct' ? DIRECT : null)
}

/** Which proxy the account goes through; «напрямую» is only an explicit choice. */
export function AccountRouteForm({ account }: { account: AccountDto }) {
  const queryClient = useQueryClient()
  const proxies = useQuery(proxiesQueryOptions)
  const [choice, setChoice] = React.useState<RouteChoice | null>(currentRoute(account))
  // follow changes made elsewhere (another admin, the worker re-assigning) unless the admin is mid-edit
  const saved = currentRoute(account)
  const [lastSaved, setLastSaved] = React.useState(saved)
  if (saved !== lastSaved) {
    setLastSaved(saved)
    setChoice(saved)
  }

  const save = useMutation({
    mutationFn: () => api<AccountDto>(`/accounts/${account.id}/proxy`, { method: 'PUT', json: { proxyId: choice === DIRECT ? null : choice } }),
    onSuccess: async (updated) => {
      queryClient.setQueryData(accountQueryOptions(account.id).queryKey, updated)
      await queryClient.invalidateQueries({ queryKey: accountsQueryOptions.queryKey, exact: true })
      await queryClient.invalidateQueries({ queryKey: proxiesQueryOptions.queryKey })
      toast.add({ title: 'Подключение изменено', description: 'Аккаунт переподключается' })
    },
  })

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        save.mutate()
      }}
    >
      <FieldGroup>
        <Field data-invalid={!!save.error || undefined}>
          <FieldLabel htmlFor="account-route">Прокси</FieldLabel>
          <RouteSelect
            id="account-route"
            value={choice}
            onChange={setChoice}
            proxies={freeProxies(proxies.data?.items ?? [], account.proxy?.id)}
            special={[{ value: DIRECT, label: 'Напрямую, без прокси' }]}
            placeholder="Выберите прокси"
          />
          <FieldDescription>
            Один прокси — один аккаунт. Без прокси Telegram увидит IP сервера панели — выбирайте это только осознанно.
          </FieldDescription>
          {save.error && <FieldError>{save.error.message}</FieldError>}
        </Field>
        <Field orientation="horizontal">
          <Button type="submit" disabled={choice === null || choice === saved || save.isPending}>
            Сохранить и переподключить
          </Button>
        </Field>
      </FieldGroup>
    </form>
  )
}
