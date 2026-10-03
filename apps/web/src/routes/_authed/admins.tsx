import * as React from 'react'
import { useMutation, useQueryClient, useSuspenseQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { createColumnHelper } from '@tanstack/react-table'
import type { AdminDto } from '@workspace/shared/api'
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
import { toast } from '@workspace/ui/components/toast'
import { MoreHorizontalIcon } from 'lucide-react'
import { CreateAdminDialog } from '@/components/admins/create-admin-dialog'
import { ResetPasswordDialog } from '@/components/admins/reset-password-dialog'
import { DataTable, type ClientTableFeatures } from '@/components/data-table'
import { PageHeader } from '@/components/page-header'
import { adminsQueryOptions } from '@/lib/admins'
import { api, ApiError } from '@/lib/api'
import { formatDateTime } from '@/lib/format'
import { titleHead } from '@/lib/title'

export const Route = createFileRoute('/_authed/admins')({
  head: titleHead('Админы'),
  loader: ({ context }) => context.queryClient.query({ ...adminsQueryOptions, staleTime: 'static' }),
  component: AdminsPage,
})

const col = createColumnHelper<ClientTableFeatures, AdminDto>()

function AdminsPage() {
  const { me } = Route.useRouteContext()
  const queryClient = useQueryClient()
  const { data } = useSuspenseQuery(adminsQueryOptions)
  const [resetTarget, setResetTarget] = React.useState<AdminDto | null>(null)
  const [disableTarget, setDisableTarget] = React.useState<AdminDto | null>(null)

  const disable = useMutation({
    mutationFn: (id: string) => api(`/admins/${id}/disable`, { method: 'POST' }),
    onSuccess: () => toast.add({ title: 'Админ отключён', description: disableTarget?.login }),
    onError: (err) => toast.add({ title: 'Не удалось отключить', description: err instanceof ApiError ? err.message : String(err) }),
    onSettled: async () => {
      setDisableTarget(null)
      await queryClient.invalidateQueries({ queryKey: adminsQueryOptions.queryKey })
    },
  })

  const columns = React.useMemo(
    () =>
      col.columns([
        col.accessor('login', {
          header: 'Логин',
          cell: (info) => (
            <span className="flex items-center gap-2">
              {info.getValue()}
              {info.row.original.id === me.id && <Badge variant="outline">вы</Badge>}
            </span>
          ),
        }),
        col.accessor('disabledAt', {
          header: 'Статус',
          cell: (info) => (info.getValue() ? <Badge variant="destructive">отключён</Badge> : <Badge variant="secondary">активен</Badge>),
        }),
        col.accessor('lastLoginAt', { header: 'Последний вход', cell: (info) => formatDateTime(info.getValue()) }),
        col.accessor('createdAt', { header: 'Создан', cell: (info) => formatDateTime(info.getValue()) }),
        col.display({
          id: 'actions',
          header: () => <span className="sr-only">Действия</span>,
          cell: ({ row }) =>
            row.original.disabledAt ? null : (
              <DropdownMenu>
                <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label={`Действия: ${row.original.login}`} />}>
                  <MoreHorizontalIcon />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuGroup>
                    <DropdownMenuItem onClick={() => setResetTarget(row.original)}>Сбросить пароль</DropdownMenuItem>
                    <DropdownMenuItem variant="destructive" onClick={() => setDisableTarget(row.original)}>
                      Отключить
                    </DropdownMenuItem>
                  </DropdownMenuGroup>
                </DropdownMenuContent>
              </DropdownMenu>
            ),
        }),
      ]),
    [me.id],
  )

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Админы" description="Все админы равны по правам. Действия записываются в аудит." actions={<CreateAdminDialog />} />
      <DataTable columns={columns} data={data.items} />
      <ResetPasswordDialog admin={resetTarget} onOpenChange={(open) => !open && setResetTarget(null)} />
      <AlertDialog open={disableTarget !== null} onOpenChange={(open) => !open && setDisableTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Отключить {disableTarget?.login}?</AlertDialogTitle>
            <AlertDialogDescription>Админ не сможет войти, его активные сессии будут завершены.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Отмена</AlertDialogCancel>
            <AlertDialogAction variant="destructive" disabled={disable.isPending} onClick={() => disableTarget && disable.mutate(disableTarget.id)}>
              Отключить
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
