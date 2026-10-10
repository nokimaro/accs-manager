import * as React from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { accountFullTitle, type AccountDto } from '@workspace/shared/accounts'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@workspace/ui/components/alert-dialog'
import { Button } from '@workspace/ui/components/button'
import { Checkbox } from '@workspace/ui/components/checkbox'
import { Field, FieldContent, FieldDescription, FieldError, FieldLabel } from '@workspace/ui/components/field'
import { toast } from '@workspace/ui/components/toast'
import { Trash2Icon } from 'lucide-react'
import { accountsQueryOptions } from '@/lib/accounts'
import { api } from '@/lib/api'
import { proxiesQueryOptions } from '@/lib/proxies'

export function DeleteAccountDialog({ account }: { account: AccountDto }) {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const [open, setOpen] = React.useState(false)
  const [logout, setLogout] = React.useState(false)

  const remove = useMutation({
    mutationFn: () => api(`/accounts/${account.id}?logout=${logout}`, { method: 'DELETE' }),
    onSuccess: async () => {
      toast.add({ title: 'Аккаунт удалён', description: accountFullTitle(account) })
      queryClient.removeQueries({ queryKey: ['accounts', account.id] })
      await queryClient.invalidateQueries({ queryKey: accountsQueryOptions.queryKey, exact: true })
      await queryClient.invalidateQueries({ queryKey: proxiesQueryOptions.queryKey })
      await navigate({ to: '/accounts' })
    },
  })

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) {
          setLogout(false)
          remove.reset()
        }
      }}
    >
      <AlertDialogTrigger render={<Button variant="destructive" />}>
        <Trash2Icon data-icon="inline-start" />
        Удалить
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Удалить аккаунт {accountFullTitle(account)}?</AlertDialogTitle>
          <AlertDialogDescription>Из панели исчезнут сессия, коды и история аккаунта. Прокси освободится.</AlertDialogDescription>
        </AlertDialogHeader>
        <Field orientation="horizontal">
          <Checkbox id="delete-logout" checked={logout} onCheckedChange={(v) => setLogout(v === true)} />
          <FieldContent>
            <FieldLabel htmlFor="delete-logout">Завершить сессию в Telegram</FieldLabel>
            <FieldDescription>Без этого сессия панели останется в списке устройств аккаунта.</FieldDescription>
          </FieldContent>
        </Field>
        {remove.error && <FieldError>{remove.error.message}</FieldError>}
        <AlertDialogFooter>
          <AlertDialogCancel>Отмена</AlertDialogCancel>
          <AlertDialogAction variant="destructive" disabled={remove.isPending} onClick={() => remove.mutate()}>
            Удалить
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
