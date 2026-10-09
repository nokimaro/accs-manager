import * as React from 'react'
import { useMutation, useQueryClient, useSuspenseQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { createColumnHelper } from '@tanstack/react-table'
import { accountTitle } from '@workspace/shared/accounts'
import { proxySourceLabels, type ProxyDto } from '@workspace/shared/proxies'
import { pluralRu } from '@workspace/shared/settings'
import { Alert, AlertDescription, AlertTitle } from '@workspace/ui/components/alert'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@workspace/ui/components/alert-dialog'
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
import { Tooltip, TooltipContent, TooltipTrigger } from '@workspace/ui/components/tooltip'
import { MoreHorizontalIcon, RefreshCwIcon } from 'lucide-react'
import { DataTable, type ClientTableFeatures } from '@/components/data-table'
import { PageHeader } from '@/components/page-header'
import { AccountName } from '@/components/accounts/account-name'
import { AddProxyDialog } from '@/components/proxies/add-proxy-dialog'
import { ImportProxiesDialog } from '@/components/proxies/import-proxies-dialog'
import { ProxyStatusBadge } from '@/components/proxies/proxy-status-badge'
import { api, ApiError } from '@/lib/api'
import { formatDate, formatDateTime, formatRelative } from '@/lib/format'
import { PROXY_STATUS_FILTERS, proxiesQueryOptions, proxySyncStatusQueryOptions, type ProxyStatusFilter } from '@/lib/proxies'
import { titleHead } from '@/lib/title'

export const Route = createFileRoute('/_authed/proxies')({
  head: titleHead('Прокси'),
  loader: ({ context }) =>
    Promise.all([
      context.queryClient.query({ ...proxiesQueryOptions, staleTime: 'static' }),
      context.queryClient.query({ ...proxySyncStatusQueryOptions, staleTime: 'static' }),
    ]),
  component: ProxiesPage,
})

const col = createColumnHelper<ClientTableFeatures, ProxyDto>()
type SourceFilter = 'all' | ProxyDto['source']
/** free: no account; shared: a reused proxy, more than one account */
type UsageFilter = 'all' | 'free' | 'shared'
const USAGE: Record<UsageFilter, (p: ProxyDto) => boolean> = {
  all: () => true,
  free: (p) => p.accounts.length === 0,
  shared: (p) => p.accounts.length > 1,
}

function matches(p: ProxyDto, query: string): boolean {
  if (!query) return true
  const q = query.toLowerCase()
  return [p.host, `${p.host}:${p.port}`, p.username, p.tag, ...p.accounts.flatMap((a) => [accountTitle(a), a.phone])].some((v) => v?.toLowerCase().includes(q))
}

function ProxiesPage() {
  const queryClient = useQueryClient()
  const { data } = useSuspenseQuery(proxiesQueryOptions)
  const { data: sync } = useSuspenseQuery(proxySyncStatusQueryOptions)
  const [statusFilter, setStatusFilter] = React.useState<ProxyStatusFilter>('all')
  const [sourceFilter, setSourceFilter] = React.useState<SourceFilter>('all')
  const [usageFilter, setUsageFilter] = React.useState<UsageFilter>('all')
  const [query, setQuery] = React.useState('')
  const [deleteTarget, setDeleteTarget] = React.useState<ProxyDto | null>(null)

  const refresh = () => queryClient.invalidateQueries({ queryKey: proxiesQueryOptions.queryKey })
  const failed = (title: string) => (err: unknown) => toast.add({ title, description: err instanceof ApiError ? err.message : String(err) })

  const check = useMutation({
    mutationFn: (p: ProxyDto) => api(`/proxies/${p.id}/check`, { method: 'POST' }),
    onSuccess: (_, p) => toast.add({ title: 'Проверка запущена', description: `${p.host}:${p.port}` }),
    onError: failed('Не удалось запустить проверку'),
  })
  const toggle = useMutation({
    mutationFn: (p: ProxyDto) => api(`/proxies/${p.id}`, { method: 'PATCH', json: { disabled: p.disabledAt === null } }),
    onSuccess: refresh,
    onError: failed('Не удалось изменить прокси'),
  })
  const remove = useMutation({
    mutationFn: (p: ProxyDto) => api(`/proxies/${p.id}`, { method: 'DELETE' }),
    onSuccess: (_, p) => toast.add({ title: 'Прокси удалён', description: `${p.host}:${p.port}` }),
    onError: failed('Не удалось удалить прокси'),
    onSettled: async () => {
      setDeleteTarget(null)
      await refresh()
    },
  })
  const syncNow = useMutation({
    mutationFn: () => api('/proxies/sync', { method: 'POST' }),
    onSuccess: () => toast.add({ title: 'Синхронизация с proxy-store запущена' }),
    onError: failed('Не удалось запустить синхронизацию'),
  })

  const statuses = PROXY_STATUS_FILTERS[statusFilter] as readonly string[] | null
  const rows = data.items.filter(
    (p) => (!statuses || statuses.includes(p.status)) && (sourceFilter === 'all' || p.source === sourceFilter) && USAGE[usageFilter](p) && matches(p, query),
  )

  const columns = React.useMemo(
    () =>
      col.columns([
        col.accessor('status', {
          header: 'Статус',
          cell: ({ row }) => {
            const p = row.original
            const badge = <ProxyStatusBadge status={p.status} />
            return (
              <span className="flex items-center gap-1.5">
                {p.lastError ? (
                  <Tooltip>
                    <TooltipTrigger render={<span />}>{badge}</TooltipTrigger>
                    <TooltipContent>{p.lastError}</TooltipContent>
                  </Tooltip>
                ) : (
                  badge
                )}
                {p.disabledAt && <Badge variant="outline">отключён</Badge>}
              </span>
            )
          },
        }),
        col.accessor('host', {
          header: 'Адрес',
          cell: ({ row }) => (
            <span className="flex flex-col">
              <span className="font-mono text-xs">
                {row.original.type === 'socks5' ? 'socks5' : 'http'}://{row.original.host}:{row.original.port}
              </span>
              {row.original.username && <span className="text-muted-foreground text-xs">{row.original.username}</span>}
            </span>
          ),
        }),
        col.accessor('source', { header: 'Источник', cell: (info) => proxySourceLabels[info.getValue()] }),
        col.accessor('latencyMs', { header: 'Задержка', cell: (info) => (info.getValue() === null ? '—' : `${info.getValue()} мс`) }),
        col.accessor('tgCountry', {
          header: () => (
            <Tooltip>
              <TooltipTrigger render={<span className="underline decoration-dotted" />}>Страна</TooltipTrigger>
              <TooltipContent>Страна выходного IP глазами Telegram</TooltipContent>
            </Tooltip>
          ),
          cell: (info) => info.getValue() ?? '—',
        }),
        col.accessor('expiresAt', { header: 'Оплачен до', cell: (info) => formatDate(info.getValue()) }),
        col.accessor('accounts', {
          header: 'Аккаунты',
          cell: (info) => {
            const bound = info.getValue()
            if (bound.length === 0) return <span className="text-muted-foreground">свободен</span>
            return (
              <span className="flex items-start gap-1.5">
                <span className="flex flex-col gap-1.5">
                  {bound.map((a) => (
                    <AccountName key={a.id} id={a.id} account={a} />
                  ))}
                </span>
                {bound.length > 1 && (
                  <Tooltip>
                    <TooltipTrigger render={<span />}>
                      <Badge variant="outline">×{bound.length}</Badge>
                    </TooltipTrigger>
                    <TooltipContent>Прокси общий: через него {pluralRu(bound.length, ['подключён', 'подключены', 'подключены'])} {bound.length} {pluralRu(bound.length, ['аккаунт', 'аккаунта', 'аккаунтов'])}</TooltipContent>
                  </Tooltip>
                )}
              </span>
            )
          },
        }),
        col.accessor('tag', { header: 'Метка', cell: (info) => info.getValue() ?? '—' }),
        col.accessor('lastCheckAt', {
          header: 'Проверен',
          cell: (info) => (
            <span title={formatDateTime(info.getValue())} className="text-muted-foreground text-sm">
              {formatRelative(info.getValue())}
            </span>
          ),
        }),
        col.display({
          id: 'actions',
          header: () => <span className="sr-only">Действия</span>,
          cell: ({ row }) => {
            const p = row.original
            const label = `${p.host}:${p.port}`
            return (
              <DropdownMenu>
                <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label={`Действия: ${label}`} />}>
                  <MoreHorizontalIcon />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuGroup>
                    <DropdownMenuItem disabled={p.status === 'provisioning' || p.status === 'expired'} onClick={() => check.mutate(p)}>
                      Проверить сейчас
                    </DropdownMenuItem>
                    <DropdownMenuItem disabled={p.disabledAt === null && p.accounts.length > 0} onClick={() => toggle.mutate(p)}>
                      {p.disabledAt ? 'Включить' : 'Отключить'}
                    </DropdownMenuItem>
                    {p.source === 'manual' && (
                      <DropdownMenuItem variant="destructive" disabled={p.accounts.length > 0} onClick={() => setDeleteTarget(p)}>
                        Удалить
                      </DropdownMenuItem>
                    )}
                  </DropdownMenuGroup>
                </DropdownMenuContent>
              </DropdownMenu>
            )
          },
        }),
      ]),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mutations are stable enough; columns only render handlers
    [],
  )

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Прокси"
        description="Пул прокси для аккаунтов. Проверяются подключением к Telegram, из proxy-store — синхронизируются автоматически."
        actions={
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" disabled={syncNow.isPending} onClick={() => syncNow.mutate()}>
              <RefreshCwIcon data-icon="inline-start" />
              Синхронизировать
            </Button>
            <ImportProxiesDialog />
            <AddProxyDialog />
          </div>
        }
      />
      {sync.status && !sync.status.ok && (
        <Alert variant="destructive">
          <AlertTitle>Синхронизация с proxy-store не удалась {formatRelative(sync.status.at)}</AlertTitle>
          <AlertDescription>{sync.status.error}</AlertDescription>
        </Alert>
      )}
      {sync.status?.ok && (
        <p className="text-muted-foreground text-sm">
          proxy-store: синхронизировано {formatRelative(sync.status.at)} — новых {sync.status.created}, обновлено {sync.status.updated}, истекло {sync.status.expired}.
        </p>
      )}
      <div className="flex flex-wrap items-end gap-4">
        <Field className="w-auto">
          <FieldLabel>Статус</FieldLabel>
          <ToggleGroup variant="outline" value={[statusFilter]} onValueChange={(v) => v[0] && setStatusFilter(v[0] as ProxyStatusFilter)}>
            <ToggleGroupItem value="all">Все</ToggleGroupItem>
            <ToggleGroupItem value="ok">Работают</ToggleGroupItem>
            <ToggleGroupItem value="problems">Проблемы</ToggleGroupItem>
            <ToggleGroupItem value="other">Остальные</ToggleGroupItem>
          </ToggleGroup>
        </Field>
        <Field className="w-auto">
          <FieldLabel>Источник</FieldLabel>
          <ToggleGroup variant="outline" value={[sourceFilter]} onValueChange={(v) => v[0] && setSourceFilter(v[0] as SourceFilter)}>
            <ToggleGroupItem value="all">Все</ToggleGroupItem>
            <ToggleGroupItem value="manual">Вручную</ToggleGroupItem>
            <ToggleGroupItem value="proxy_store">proxy-store</ToggleGroupItem>
          </ToggleGroup>
        </Field>
        <Field className="w-auto">
          <FieldLabel>Аккаунты</FieldLabel>
          <ToggleGroup variant="outline" value={[usageFilter]} onValueChange={(v) => v[0] && setUsageFilter(v[0] as UsageFilter)}>
            <ToggleGroupItem value="all">Все</ToggleGroupItem>
            <ToggleGroupItem value="free">Свободные</ToggleGroupItem>
            <ToggleGroupItem value="shared">Общие</ToggleGroupItem>
          </ToggleGroup>
        </Field>
        <Field className="w-64">
          <FieldLabel htmlFor="proxy-search">Поиск</FieldLabel>
          <Input id="proxy-search" placeholder="адрес, логин, метка, аккаунт" value={query} onChange={(e) => setQuery(e.target.value)} />
        </Field>
      </div>
      <DataTable columns={columns} data={rows} pageSize={50} empty={data.items.length ? 'Ничего не найдено' : 'Прокси ещё нет — добавьте вручную или импортируйте список'} />
      <AlertDialog open={deleteTarget !== null} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Удалить {deleteTarget?.host}:{deleteTarget?.port}?
            </AlertDialogTitle>
            <AlertDialogDescription>Прокси исчезнет из пула. Вернуть его можно, только добавив заново.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Отмена</AlertDialogCancel>
            <AlertDialogAction variant="destructive" disabled={remove.isPending} onClick={() => deleteTarget && remove.mutate(deleteTarget)}>
              Удалить
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
