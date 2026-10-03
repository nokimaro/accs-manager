import * as React from 'react'
import { useMutation } from '@tanstack/react-query'
import type { AdminDto } from '@workspace/shared/api'
import { Button } from '@workspace/ui/components/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@workspace/ui/components/dialog'
import { Field, FieldError, FieldGroup, FieldLabel } from '@workspace/ui/components/field'
import { Spinner } from '@workspace/ui/components/spinner'
import { toast } from '@workspace/ui/components/toast'
import { PasswordInput } from '@/components/password-input'
import { api, ApiError } from '@/lib/api'

export function ResetPasswordDialog({ admin, onOpenChange }: { admin: AdminDto | null; onOpenChange: (open: boolean) => void }) {
  const [password, setPassword] = React.useState('')
  const mutation = useMutation({
    mutationFn: (id: string) => api(`/admins/${id}/reset-password`, { method: 'POST', json: { password } }),
    onSuccess: () => {
      toast.add({ title: 'Пароль сброшен', description: `${admin?.login}: все его сессии завершены.` })
      onOpenChange(false)
      setPassword('')
    },
    onError: (err) => {
      if (!(err instanceof ApiError)) {
        toast.add({ title: 'Не удалось сбросить пароль', description: err instanceof Error ? err.message : String(err) })
      }
    },
  })
  const error = mutation.error instanceof ApiError ? (mutation.error.fields.password ?? mutation.error.message) : undefined
  const handleOpenChange = (next: boolean) => {
    // never keep a typed password or a stale error after the dialog closes
    if (!next) {
      setPassword('')
      mutation.reset()
    }
    onOpenChange(next)
  }
  return (
    <Dialog open={admin !== null} onOpenChange={handleOpenChange}>
      <DialogContent>
        <form
          className="flex flex-col gap-6"
          onSubmit={(e) => {
            e.preventDefault()
            if (admin) mutation.mutate(admin.id)
          }}
        >
          <DialogHeader>
            <DialogTitle>Сбросить пароль: {admin?.login}</DialogTitle>
            <DialogDescription>Все активные сессии этого админа будут завершены.</DialogDescription>
          </DialogHeader>
          <FieldGroup>
            <Field data-invalid={error ? true : undefined}>
              <FieldLabel htmlFor="reset-password">Новый пароль</FieldLabel>
              <PasswordInput id="reset-password" required minLength={10} autoComplete="new-password" value={password}
                onChange={(e) => setPassword(e.target.value)} aria-invalid={error ? true : undefined} />
              {error && <FieldError>{error}</FieldError>}
            </Field>
          </FieldGroup>
          <DialogFooter>
            <Button type="submit" disabled={mutation.isPending}>
              {mutation.isPending && <Spinner data-icon="inline-start" />}
              Сбросить
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
