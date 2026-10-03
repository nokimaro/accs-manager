import * as React from 'react'
import { useQuery } from '@tanstack/react-query'
import { createFileRoute, stripSearchParams } from '@tanstack/react-router'
import { createColumnHelper } from '@tanstack/react-table'
import type { AuditEntryDto } from '@workspace/shared/api'
import { Alert, AlertAction, AlertTitle } from '@workspace/ui/components/alert'
import { Badge } from '@workspace/ui/components/badge'
import { Button } from '@workspace/ui/components/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@workspace/ui/components/dialog'
import { Field, FieldLabel } from '@workspace/ui/components/field'
import { Input } from '@workspace/ui/components/input'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@workspace/ui/components/select'
import { Skeleton } from '@workspace/ui/components/skeleton'
import { ToggleGroup, ToggleGroupItem } from '@workspace/ui/components/toggle-group'
import { z } from 'zod'
import { ServerDataTable, type ServerTableFeatures } from '@/components/data-table'
import { PageHeader } from '@/components/page-header'
import { adminsQueryOptions } from '@/lib/admins'
import { auditQueryOptions, type AuditPeriod } from '@/lib/audit'
import { formatDateTime } from '@/lib/format'

const defaults = { page: 1, period: '7d' as AuditPeriod }
const auditSearch = z.object({
  page: z.number().int().min(1).default(defaults.page).catch(defaults.page),
  period: z.enum(['24h', '7d', '30d', 'all']).default(defaults.period).catch(defaults.period),
  action: z.string().max(100).optional().catch(undefined),
  adminId: z.uuid().optional().catch(undefined),
})

export const Route = createFileRoute('/_authed/audit')({
  validateSearch: auditSearch,
  search: { middlewares: [stripSearchParams(defaults)] },
  component: AuditPage,
})

const PAGE_SIZE = 50
const col = createColumnHelper<ServerTableFeatures, AuditEntryDto>()

function actorLabel(e: AuditEntryDto): string {
  if (e.actorType === 'cli') return 'CLI'
  if (e.actorType === 'system') return 'система'
  return e.adminLogin ?? 'аноним'
}

function AuditPage() {
  const search = Route.useSearch()
  const navigate = Route.useNavigate()
  const [details, setDetails] = React.useState<AuditEntryDto | null>(null)
  const [actionDraft, setActionDraft] = React.useState(search.action ?? '')
  const admins = useQuery(adminsQueryOptions)
  const { data, isPending, isError, refetch } = useQuery(auditQueryOptions({ ...search, pageSize: PAGE_SIZE }))

  const columns = React.useMemo(
    () =>
      col.columns([
        col.accessor('createdAt', { header: 'Время', cell: (i) => <span className="whitespace-nowrap">{formatDateTime(i.getValue())}</span> }),
        col.display({ id: 'actor', header: 'Кто', cell: ({ row }) => actorLabel(row.original) }),
        col.accessor('action', { header: 'Действие', cell: (i) => <Badge variant="outline">{i.getValue()}</Badge> }),
        col.display({
          id: 'target',
          header: 'Объект',
          cell: ({ row }) => (row.original.targetType ? `${row.original.targetType}:${row.original.targetId?.slice(0, 8) ?? ''}` : '—'),
        }),
        col.accessor('result', {
          header: 'Результат',
          cell: (i) => (
            <Badge variant={i.getValue() === 'ok' ? 'secondary' : 'destructive'}>
              {i.getValue() === 'ok' ? 'ок' : 'ошибка'}{i.row.original.statusCode ? ` ${i.row.original.statusCode}` : ''}
            </Badge>
          ),
        }),
        col.accessor('ip', { header: 'IP', cell: (i) => i.getValue() ?? '—' }),
        col.display({
          id: 'details',
          header: () => <span className="sr-only">Подробнее</span>,
          cell: ({ row }) => (
            <Button variant="ghost" size="sm" onClick={() => setDetails(row.original)}>
              Подробнее
            </Button>
          ),
        }),
      ]),
    [],
  )

  const adminItems = [{ label: 'Все', value: null as string | null }, ...(admins.data?.items ?? []).map((a) => ({ label: a.login, value: a.id }))]
  const setSearch = (patch: Partial<typeof search>) => void navigate({ search: (prev) => ({ ...prev, page: 1, ...patch }) })

  const commitAction = () => {
    const next = actionDraft.trim() || undefined
    if (next !== search.action) setSearch({ action: next })
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Аудит" description="Все изменяющие действия админов, CLI и системы." />
      <div className="flex flex-wrap items-end gap-4">
        <Field className="w-auto">
          <FieldLabel>Период</FieldLabel>
          <ToggleGroup variant="outline" value={[search.period]} onValueChange={(v) => v[0] && setSearch({ period: v[0] as AuditPeriod })}>
            <ToggleGroupItem value="24h">24 часа</ToggleGroupItem>
            <ToggleGroupItem value="7d">7 дней</ToggleGroupItem>
            <ToggleGroupItem value="30d">30 дней</ToggleGroupItem>
            <ToggleGroupItem value="all">Всё время</ToggleGroupItem>
          </ToggleGroup>
        </Field>
        <Field className="w-48">
          <FieldLabel htmlFor="audit-admin">Админ</FieldLabel>
          <Select items={adminItems} value={search.adminId ?? null} onValueChange={(v) => setSearch({ adminId: v ?? undefined })}>
            <SelectTrigger id="audit-admin" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {adminItems.map((item) => (
                  <SelectItem key={item.label} value={item.value}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </Field>
        <form
          className="contents"
          onSubmit={(e) => {
            e.preventDefault()
            commitAction()
          }}
        >
          <Field className="w-64">
            <FieldLabel htmlFor="audit-action">Действие</FieldLabel>
            <Input id="audit-action" placeholder="например settings.update" value={actionDraft} onChange={(e) => setActionDraft(e.target.value)}
              onBlur={commitAction} />
          </Field>
        </form>
      </div>
      {isError ? (
        <Alert variant="destructive">
          <AlertTitle>Не удалось загрузить аудит</AlertTitle>
          <AlertAction>
            <Button size="sm" variant="outline" onClick={() => void refetch()}>
              Повторить
            </Button>
          </AlertAction>
        </Alert>
      ) : isPending ? (
        <Skeleton className="h-64 w-full" />
      ) : (
        <ServerDataTable
          columns={columns}
          data={data?.items ?? []}
          rowCount={data?.total ?? 0}
          pagination={{ pageIndex: search.page - 1, pageSize: PAGE_SIZE }}
          onPageChange={(pageIndex) => void navigate({ search: (prev) => ({ ...prev, page: pageIndex + 1 }) })}
          empty="Записей нет"
        />
      )}
      <Dialog open={details !== null} onOpenChange={(open) => !open && setDetails(null)}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{details?.action}</DialogTitle>
            <DialogDescription>
              {details && `${formatDateTime(details.createdAt)} · ${actorLabel(details)} · ${details.ip ?? '—'} · ${details.durationMs ?? '—'} мс`}
            </DialogDescription>
          </DialogHeader>
          <pre className="bg-muted max-h-96 overflow-auto rounded-lg p-3 text-xs">{JSON.stringify(details?.payload ?? null, null, 2)}</pre>
          {details?.userAgent && <p className="text-muted-foreground text-xs break-all">{details.userAgent}</p>}
        </DialogContent>
      </Dialog>
    </div>
  )
}
