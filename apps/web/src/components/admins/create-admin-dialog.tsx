import * as React from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Button } from '@workspace/ui/components/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@workspace/ui/components/dialog'
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from '@workspace/ui/components/field'
import { Input } from '@workspace/ui/components/input'
import { Spinner } from '@workspace/ui/components/spinner'
import { toast } from '@workspace/ui/components/toast'
import { PlusIcon } from 'lucide-react'
import { PasswordInput } from '@/components/password-input'
import { adminsQueryOptions } from '@/lib/admins'
import { api, ApiError } from '@/lib/api'

export function CreateAdminDialog() {
  const queryClient = useQueryClient()
  const [open, setOpen] = React.useState(false)
  const [login, setLogin] = React.useState('')
  const [password, setPassword] = React.useState('')
  const mutation = useMutation({
    mutationFn: () => api('/admins', { method: 'POST', json: { login, password } }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: adminsQueryOptions.queryKey })
      toast.add({ title: 'Админ создан', description: login })
      setOpen(false)
      setLogin('')
      setPassword('')
      mutation.reset()
    },
  })
  const err = mutation.error instanceof ApiError ? mutation.error : null
  const fields = err?.fields ?? {}
  const loginError = fields.login ?? (err?.status === 409 ? err.message : undefined)

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button />}>
        <PlusIcon data-icon="inline-start" />
        Добавить админа
      </DialogTrigger>
      <DialogContent>
        <form
          className="flex flex-col gap-6"
          onSubmit={(e) => {
            e.preventDefault()
            mutation.mutate()
          }}
        >
          <DialogHeader>
            <DialogTitle>Новый админ</DialogTitle>
            <DialogDescription>У всех админов одинаковые полные права.</DialogDescription>
          </DialogHeader>
          <FieldGroup>
            <Field data-invalid={loginError ? true : undefined}>
              <FieldLabel htmlFor="new-admin-login">Логин</FieldLabel>
              <Input id="new-admin-login" required autoComplete="off" value={login} onChange={(e) => setLogin(e.target.value)} aria-invalid={loginError ? true : undefined} />
              <FieldDescription>3–32 символа: латиница, цифры, точка, дефис, подчёркивание.</FieldDescription>
              {loginError && <FieldError>{loginError}</FieldError>}
            </Field>
            <Field data-invalid={fields.password ? true : undefined}>
              <FieldLabel htmlFor="new-admin-password">Пароль</FieldLabel>
              <PasswordInput id="new-admin-password" required minLength={10} autoComplete="new-password" value={password}
                onChange={(e) => setPassword(e.target.value)} aria-invalid={fields.password ? true : undefined} />
              {fields.password && <FieldError>{fields.password}</FieldError>}
            </Field>
          </FieldGroup>
          <DialogFooter>
            <Button type="submit" disabled={mutation.isPending}>
              {mutation.isPending && <Spinner data-icon="inline-start" />}
              Создать
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
