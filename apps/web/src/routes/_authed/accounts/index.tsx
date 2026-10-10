import * as React from 'react'
import { useMutation, useQueryClient, useSuspenseQuery } from '@tanstack/react-query'
import { createFileRoute, Link } from '@tanstack/react-router'
import { createColumnHelper } from '@tanstack/react-table'
import { accountSourceLabels, accountTitle, type AccountDto } from '@workspace/shared/accounts'
import { Badge } from '@workspace/ui/components/badge'
import { Button } from '@workspace/ui/components/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@workspace/ui/components/dropdown-menu'
import { Field, FieldLabel } from '@workspace/ui/components/field'
import { Input } from '@workspace/ui/components/input'
import { toast } from '@workspace/ui/components/toast'
import { ToggleGroup, ToggleGroupItem } from '@workspace/ui/components/toggle-group'
import { MoreHorizontalIcon } from 'lucide-react'
import { AccountName } from '@/components/accounts/account-name'
import { AccountStatusBadge } from '@/components/accounts/account-status-badge'
import { AddAccountDialog } from '@/components/accounts/add-account-dialog'
import { DataTable, type ClientTableFeatures } from '@/components/data-table'
import { CopyCodeButton } from '@/components/codes/copy-code-button'
import { PageHeader } from '@/components/page-header'
import { ProxyStatusBadge } from '@/components/proxies/proxy-status-badge'
import { ACCOUNT_STATUS_FILTERS, accountsQueryOptions, type AccountStatusFilter } from '@/lib/accounts'
import { api, ApiError } from '@/lib/api'
import { TimeAgo } from '@/components/time-ago'
import { titleHead } from '@/lib/title'

export const Route = createFileRoute('/_authed/accounts/')({
  head: titleHead('Аккаунты'),
  loader: ({ context }) => context.queryClient.query({ ...accountsQueryOptions, staleTime: 'static' }),
  component: AccountsPage,
})

const col = createColumnHelper<ClientTableFeatures, AccountDto>()

function matches(a: AccountDto, query: string): boolean {
  if (!query) return true
  const q = query.toLowerCase().replace(/^\+/, '')
  return [a.label, a.phone, a.username, a.firstName, a.lastName, String(a.tgUserId), a.note].some((v) => v?.toLowerCase().includes(q))
}

function AccountsPage() {
  const queryClient = useQueryClient()
  const { data } = useSuspenseQuery(accountsQueryOptions)
  const [statusFilter, setStatusFilter] = React.useState<AccountStatusFilter>('all')
  const [query, setQuery] = React.useState('')

  const action = useMutation({
    mutationFn: ({ a, verb }: { a: AccountDto; verb: 'pause' | 'resume' | 'reconnect' }) => api(`/accounts/${a.id}/${verb}`, { method: 'POST' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: accountsQueryOptions.queryKey }),
    onError: (err) => toast.add({ title: 'Не получилось', description: err instanceof ApiError ? err.message : String(err) }),
  })

  const statuses = ACCOUNT_STATUS_FILTERS[statusFilter] as readonly string[] | null
  const rows = data.items.filter((a) => (!statuses || statuses.includes(a.status)) && matches(a, query))

  const columns = React.useMemo(
    () =>
      col.columns([
        col.display({
          id: 'account',
          header: 'Аккаунт',
          cell: ({ row }) => {
            const a = row.original
            const name = [a.firstName, a.lastName].filter(Boolean).join(' ')
            return <AccountName id={a.id} account={a} extra={[name, a.username && `@${a.username}`].filter(Boolean).join(' · ') || `id ${a.tgUserId}`} />
          },
        }),
        col.accessor('lastCodeAt', {
          header: 'Последний код',
          cell: ({ row }) => {
            const a = row.original
            if (!a.lastCodeAt) return <span className="text-muted-foreground">—</span>
            return (
              <span className="flex flex-col items-start gap-1">
                {a.lastCode ? <CopyCodeButton code={a.lastCode} /> : <Badge variant="outline">без кода</Badge>}
                <TimeAgo iso={a.lastCodeAt} className="text-xs" />
              </span>
            )
          },
        }),
        col.accessor('status', { header: 'Статус', cell: ({ row }) => <AccountStatusBadge status={row.original.status} reason={row.original.statusReason} /> }),
        col.accessor('proxy', {
          header: 'Прокси',
          cell: ({ row }) => {
            const p = row.original.proxy
            if (!p) return row.original.connectionMode === 'direct' ? <Badge variant="outline">напрямую</Badge> : <span className="text-muted-foreground">не назначен</span>
            return (
              <span className="flex items-center gap-2">
                <span className="font-mono text-xs">
                  {p.host}:{p.port}
                </span>
                {p.tgCountry && <span className="text-muted-foreground text-xs">{p.tgCountry}</span>}
                {p.status !== 'ok' && <ProxyStatusBadge status={p.status} />}
              </span>
            )
          },
        }),
        col.accessor('lastOkAt', { header: 'На связи', cell: (info) => <TimeAgo iso={info.getValue()} /> }),
        col.accessor('source', { header: 'Источник', cell: (info) => accountSourceLabels[info.getValue()] }),
        col.display({
          id: 'actions',
          header: () => <span className="sr-only">Действия</span>,
          cell: ({ row }) => {
            const a = row.original
            return (
              <DropdownMenu>
                <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label={`Действия: ${accountTitle(a)}`} />}>
                  <MoreHorizontalIcon />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuGroup>
                    <DropdownMenuItem render={<Link to="/accounts/$id" params={{ id: a.id }} />}>Открыть</DropdownMenuItem>
                    {a.status === 'paused' ? (
                      <DropdownMenuItem onClick={() => action.mutate({ a, verb: 'resume' })}>Возобновить</DropdownMenuItem>
                    ) : (
                      <DropdownMenuItem disabled={a.status === 'unauthorized' || a.status === 'banned'} onClick={() => action.mutate({ a, verb: 'pause' })}>
                        Пауза
                      </DropdownMenuItem>
                    )}
                    <DropdownMenuItem disabled={a.status === 'paused' || a.status === 'unauthorized' || a.status === 'banned'} onClick={() => action.mutate({ a, verb: 'reconnect' })}>
                      Переподключить
                    </DropdownMenuItem>
                  </DropdownMenuGroup>
                </DropdownMenuContent>
              </DropdownMenu>
            )
          },
        }),
      ]),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `action.mutate` is stable
    [],
  )

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Аккаунты" description="Telegram-аккаунты панели: перенесённые из tdata и вошедшие новой сессией — по QR или по номеру." actions={<AddAccountDialog />} />
      <div className="flex flex-wrap items-end gap-4">
        <Field className="w-auto">
          <FieldLabel>Статус</FieldLabel>
          <ToggleGroup variant="outline" value={[statusFilter]} onValueChange={(v) => v[0] && setStatusFilter(v[0] as AccountStatusFilter)}>
            <ToggleGroupItem value="all">Все</ToggleGroupItem>
            <ToggleGroupItem value="active">Работают</ToggleGroupItem>
            <ToggleGroupItem value="problems">Проблемы</ToggleGroupItem>
            <ToggleGroupItem value="other">Остальные</ToggleGroupItem>
          </ToggleGroup>
        </Field>
        <Field className="w-64">
          <FieldLabel htmlFor="account-search">Поиск</FieldLabel>
          <Input id="account-search" placeholder="метка, телефон, @username, id" value={query} onChange={(e) => setQuery(e.target.value)} />
        </Field>
      </div>
      <DataTable columns={columns} data={rows} pageSize={50} empty={data.items.length ? 'Ничего не найдено' : 'Аккаунтов пока нет — добавьте из tdata или по QR'} />
    </div>
  )
}
