import * as React from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { AccountSessionDto } from '@workspace/shared/accounts'
import { Alert, AlertDescription } from '@workspace/ui/components/alert'
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
import { Spinner } from '@workspace/ui/components/spinner'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@workspace/ui/components/table'
import { toast } from '@workspace/ui/components/toast'
import { accountSessionsQueryOptions } from '@/lib/accounts'
import { api, ApiError } from '@/lib/api'
import { formatDateTime, formatRelative } from '@/lib/format'

function sessionTitle(s: AccountSessionDto): string {
  return `${s.appName} ${s.appVersion}`.trim()
}

/** Active Telegram sessions: fetched only on demand — the request goes through the worker to Telegram and is audited. */
export function AccountSessions({ accountId, running }: { accountId: string; running: boolean }) {
  const queryClient = useQueryClient()
  const [shown, setShown] = React.useState(false)
  const [target, setTarget] = React.useState<AccountSessionDto | null>(null)
  const sessions = useQuery({ ...accountSessionsQueryOptions(accountId), enabled: shown })

  const terminate = useMutation({
    mutationFn: (s: AccountSessionDto) => api(`/accounts/${accountId}/sessions/${s.hash}`, { method: 'DELETE' }),
    onSuccess: (_, s) => toast.add({ title: 'Сессия завершена', description: sessionTitle(s) }),
    onError: (err) => toast.add({ title: 'Не удалось завершить сессию', description: err instanceof ApiError ? err.message : String(err) }),
    onSettled: async () => {
      setTarget(null)
      await queryClient.invalidateQueries({ queryKey: accountSessionsQueryOptions(accountId).queryKey })
    },
  })

  if (!shown) {
    return (
      <div className="flex flex-col items-start gap-2">
        <p className="text-muted-foreground text-sm">Список устройств запрашивается у Telegram по кнопке; каждый просмотр пишется в аудит.</p>
        <Button variant="outline" disabled={!running} onClick={() => setShown(true)}>
          Показать активные сессии
        </Button>
      </div>
    )
  }
  if (sessions.isPending) return <Spinner />
  if (sessions.error) {
    return (
      <Alert variant="destructive">
        <AlertDescription>{sessions.error.message}</AlertDescription>
      </Alert>
    )
  }

  return (
    <>
      <div className="overflow-hidden rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Приложение</TableHead>
              <TableHead>Устройство</TableHead>
              <TableHead>IP и страна</TableHead>
              <TableHead>Активность</TableHead>
              <TableHead>
                <span className="sr-only">Действия</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {sessions.data.items.map((s) => (
              <TableRow key={s.hash}>
                <TableCell>
                  <span className="flex items-center gap-2">
                    {sessionTitle(s)}
                    {s.current && <Badge variant="secondary">панель</Badge>}
                    {!s.official && <Badge variant="outline">неофициальное</Badge>}
                  </span>
                </TableCell>
                <TableCell className="text-sm">{[s.deviceModel, s.platform, s.systemVersion].filter(Boolean).join(', ')}</TableCell>
                <TableCell className="text-sm">{[s.ip, s.country].filter(Boolean).join(' · ')}</TableCell>
                <TableCell className="text-sm" title={`вход: ${formatDateTime(s.createdAt)}`}>
                  {formatRelative(s.activeAt)}
                </TableCell>
                <TableCell className="text-right">
                  {!s.current && (
                    <Button variant="ghost" size="sm" onClick={() => setTarget(s)}>
                      Завершить
                    </Button>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <AlertDialog open={target !== null} onOpenChange={(open) => !open && setTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Завершить сессию {target && sessionTitle(target)}?</AlertDialogTitle>
            <AlertDialogDescription>Устройство выйдет из аккаунта. Telegram может не дать завершить чужие сессии, если сессия панели моложе суток.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Отмена</AlertDialogCancel>
            <AlertDialogAction variant="destructive" disabled={terminate.isPending} onClick={() => target && terminate.mutate(target)}>
              Завершить
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
