import * as React from 'react'
import { useMutation, useQuery, useQueryClient, useSuspenseQuery } from '@tanstack/react-query'
import { createFileRoute, Link } from '@tanstack/react-router'
import { accountTitle, FINAL_STATUSES, RUNNING_STATUSES, type AccountDto } from '@workspace/shared/accounts'
import { Alert, AlertDescription, AlertTitle } from '@workspace/ui/components/alert'
import { Badge } from '@workspace/ui/components/badge'
import { Button } from '@workspace/ui/components/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@workspace/ui/components/card'
import { toast } from '@workspace/ui/components/toast'
import { ArrowLeftIcon, PauseIcon, PlayIcon, RefreshCwIcon } from 'lucide-react'
import { AccountNotesForm } from '@/components/accounts/account-notes-form'
import { AccountRouteForm } from '@/components/accounts/account-route-form'
import { AccountSessions } from '@/components/accounts/account-sessions'
import { AccountStatusBadge } from '@/components/accounts/account-status-badge'
import { DeleteAccountDialog } from '@/components/accounts/delete-account-dialog'
import { CodesTable } from '@/components/codes/codes-table'
import { PageHeader } from '@/components/page-header'
import { ProxyStatusBadge } from '@/components/proxies/proxy-status-badge'
import { accountQueryOptions, accountsQueryOptions, codesQueryOptions } from '@/lib/accounts'
import { api, ApiError } from '@/lib/api'
import { formatDate, formatDateTime, formatRelative } from '@/lib/format'
import { pageTitle } from '@/lib/title'

export const Route = createFileRoute('/_authed/accounts/$id')({
  loader: ({ context, params }) => context.queryClient.query({ ...accountQueryOptions(params.id), staleTime: 'static' }),
  head: ({ loaderData }) => ({ meta: [{ title: pageTitle(loaderData ? accountTitle(loaderData) : 'Аккаунт', 'Аккаунты') }] }),
  component: AccountPage,
})

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[10rem_1fr] gap-2 py-1.5 text-sm">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </div>
  )
}

function ProfileCard({ a }: { a: AccountDto }) {
  const name = [a.firstName, a.lastName].filter(Boolean).join(' ')
  return (
    <Card>
      <CardHeader>
        <CardTitle>Профиль</CardTitle>
        <CardDescription>Обновляется из Telegram при подключении и раз в несколько часов.</CardDescription>
      </CardHeader>
      <CardContent>
        <dl className="divide-y">
          <Row label="Статус">
            <span className="flex flex-wrap items-center gap-2">
              <AccountStatusBadge status={a.status} />
              <span className="text-muted-foreground" title={formatDateTime(a.statusChangedAt)}>
                {formatRelative(a.statusChangedAt)}
              </span>
            </span>
          </Row>
          {a.statusReason && <Row label="Причина">{a.statusReason}</Row>}
          <Row label="Телефон">{a.phone ? `+${a.phone}` : '—'}</Row>
          <Row label="Имя">
            <span className="flex items-center gap-2">
              {name || '—'}
              {a.isPremium && <Badge variant="secondary">Premium</Badge>}
            </span>
          </Row>
          <Row label="Username">{a.username ? `@${a.username}` : '—'}</Row>
          <Row label="Telegram ID">
            <span className="font-mono">{a.tgUserId}</span>
          </Row>
          <Row label="Дата-центр">{a.dcId ? `DC${a.dcId}` : '—'}</Row>
          <Row label="На связи">
            <span title={formatDateTime(a.lastOkAt)}>{formatRelative(a.lastOkAt)}</span>
          </Row>
          <Row label="Добавлен">
            {formatDate(a.createdAt)} · {a.source === 'tdata' ? 'из tdata' : 'вход по QR'}
          </Row>
          <Row label="Устройство">
            {a.device.deviceModel}, {a.device.systemVersion}, {a.clientProfile === 'desktop' ? 'Telegram Desktop' : 'своё приложение'} {a.device.appVersion}
          </Row>
        </dl>
      </CardContent>
    </Card>
  )
}

function AccountPage() {
  const { id } = Route.useParams()
  const queryClient = useQueryClient()
  const { data: a } = useSuspenseQuery(accountQueryOptions(id))
  const codes = useQuery(codesQueryOptions(id))
  const running = RUNNING_STATUSES.includes(a.status)
  const final = FINAL_STATUSES.includes(a.status)

  const action = useMutation({
    mutationFn: (verb: 'pause' | 'resume' | 'reconnect') => api(`/accounts/${id}/${verb}`, { method: 'POST' }),
    onSuccess: async (_, verb) => {
      if (verb === 'reconnect') toast.add({ title: 'Переподключение запущено' })
      await queryClient.invalidateQueries({ queryKey: accountsQueryOptions.queryKey })
    },
    onError: (err) => toast.add({ title: 'Не получилось', description: err instanceof ApiError ? err.message : String(err) }),
  })

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Button variant="ghost" size="sm" render={<Link to="/accounts" />}>
          <ArrowLeftIcon data-icon="inline-start" />
          Аккаунты
        </Button>
      </div>
      <PageHeader
        title={accountTitle(a)}
        description={a.note ?? undefined}
        actions={
          <>
            {a.status === 'paused' ? (
              <Button variant="outline" disabled={action.isPending} onClick={() => action.mutate('resume')}>
                <PlayIcon data-icon="inline-start" />
                Возобновить
              </Button>
            ) : (
              <Button variant="outline" disabled={final || action.isPending} onClick={() => action.mutate('pause')}>
                <PauseIcon data-icon="inline-start" />
                Пауза
              </Button>
            )}
            <Button variant="outline" disabled={!running && a.status !== 'proxy_down'} onClick={() => action.mutate('reconnect')}>
              <RefreshCwIcon data-icon="inline-start" />
              Переподключить
            </Button>
            <DeleteAccountDialog account={a} />
          </>
        }
      />
      {a.status === 'frozen' && (
        <Alert>
          <AlertTitle>Аккаунт заморожен Telegram</AlertTitle>
          <AlertDescription>
            Коды продолжают приходить, но многие действия недоступны{a.frozenUntil ? ` до ${formatDate(a.frozenUntil)}` : ''}.
          </AlertDescription>
        </Alert>
      )}
      {final && (
        <Alert variant="destructive">
          <AlertTitle>{a.status === 'banned' ? 'Аккаунт заблокирован Telegram' : 'Сессия больше не действует'}</AlertTitle>
          <AlertDescription>
            {a.status === 'banned' ? 'Восстановить работу из панели нельзя.' : 'Её завершили на другом устройстве. Добавьте аккаунт заново из свежей tdata или по QR.'}
          </AlertDescription>
        </Alert>
      )}
      <div className="grid gap-6 lg:grid-cols-2">
        <ProfileCard a={a} />
        <div className="flex flex-col gap-6">
          <Card>
            <CardHeader>
              <CardTitle>Подключение</CardTitle>
              <CardDescription>
                {a.proxy ? (
                  <span className="flex flex-wrap items-center gap-2">
                    Сейчас: <span className="font-mono">{`${a.proxy.host}:${a.proxy.port}`}</span>
                    {a.proxy.tgCountry && <span>{a.proxy.tgCountry}</span>}
                    <ProxyStatusBadge status={a.proxy.status} />
                  </span>
                ) : a.connectionMode === 'direct' ? (
                  'Сейчас: напрямую, без прокси'
                ) : (
                  'Прокси не назначен — аккаунт ждёт'
                )}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <AccountRouteForm key={a.id} account={a} />
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Метка и заметка</CardTitle>
            </CardHeader>
            <CardContent>
              <AccountNotesForm key={a.id} account={a} />
            </CardContent>
          </Card>
        </div>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Активные сессии</CardTitle>
          <CardDescription>Устройства, на которых открыт этот аккаунт.</CardDescription>
        </CardHeader>
        <CardContent>
          <AccountSessions key={a.id} accountId={a.id} running={a.status === 'active' || a.status === 'frozen'} />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Коды</CardTitle>
          <CardDescription>Сообщения от @VerificationCodes, последние 100.</CardDescription>
        </CardHeader>
        <CardContent>
          {codes.data ? <CodesTable items={codes.data.items} empty="Кодов пока не было" /> : <p className="text-muted-foreground text-sm">Загрузка…</p>}
        </CardContent>
      </Card>
    </div>
  )
}
