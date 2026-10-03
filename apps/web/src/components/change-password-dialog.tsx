import * as React from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useRouter } from '@tanstack/react-router'
import { Button } from '@workspace/ui/components/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@workspace/ui/components/dialog'
import { Field, FieldError, FieldGroup, FieldLabel } from '@workspace/ui/components/field'
import { Spinner } from '@workspace/ui/components/spinner'
import { toast } from '@workspace/ui/components/toast'
import { api, ApiError } from '@/lib/api'
import { authKeys } from '@/lib/auth'
import { PasswordInput } from './password-input'

export function ChangePasswordDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const queryClient = useQueryClient()
  const router = useRouter()
  const [currentPassword, setCurrentPassword] = React.useState('')
  const [newPassword, setNewPassword] = React.useState('')
  const mutation = useMutation({
    mutationFn: () => api('/auth/password', { method: 'POST', json: { currentPassword, newPassword } }),
    onSuccess: async () => {
      onOpenChange(false)
      toast.add({ title: 'Пароль изменён', description: 'Войдите с новым паролем.' })
      queryClient.clear()
      queryClient.setQueryData(authKeys.me, null)
      await router.invalidate()
    },
  })
  const fields = mutation.error instanceof ApiError ? mutation.error.fields : {}

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form
          className="flex flex-col gap-6"
          onSubmit={(e) => {
            e.preventDefault()
            mutation.mutate()
          }}
        >
          <DialogHeader>
            <DialogTitle>Сменить пароль</DialogTitle>
            <DialogDescription>После смены все ваши сессии будут завершены.</DialogDescription>
          </DialogHeader>
          <FieldGroup>
            <Field data-invalid={fields.currentPassword ? true : undefined}>
              <FieldLabel htmlFor="current-password">Текущий пароль</FieldLabel>
              <PasswordInput id="current-password" autoComplete="current-password" required value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)} aria-invalid={fields.currentPassword ? true : undefined} />
              {fields.currentPassword && <FieldError>{fields.currentPassword}</FieldError>}
            </Field>
            <Field data-invalid={fields.newPassword ? true : undefined}>
              <FieldLabel htmlFor="new-password">Новый пароль</FieldLabel>
              <PasswordInput id="new-password" autoComplete="new-password" required minLength={10} value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)} aria-invalid={fields.newPassword ? true : undefined} />
              {fields.newPassword && <FieldError>{fields.newPassword}</FieldError>}
            </Field>
          </FieldGroup>
          <DialogFooter>
            <Button type="submit" disabled={mutation.isPending}>
              {mutation.isPending && <Spinner data-icon="inline-start" />}
              Сменить
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
