import * as React from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { AccountDto } from '@workspace/shared/accounts'
import { Button } from '@workspace/ui/components/button'
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from '@workspace/ui/components/field'
import { Input } from '@workspace/ui/components/input'
import { Textarea } from '@workspace/ui/components/textarea'
import { toast } from '@workspace/ui/components/toast'
import { accountQueryOptions, accountsQueryOptions } from '@/lib/accounts'
import { api, ApiError } from '@/lib/api'

export function AccountNotesForm({ account }: { account: AccountDto }) {
  const queryClient = useQueryClient()
  const [label, setLabel] = React.useState(account.label ?? '')
  const [note, setNote] = React.useState(account.note ?? '')

  const save = useMutation({
    mutationFn: () => api<AccountDto>(`/accounts/${account.id}`, { method: 'PATCH', json: { label: label.trim() || null, note: note.trim() || null } }),
    onSuccess: async (updated) => {
      queryClient.setQueryData(accountQueryOptions(account.id).queryKey, updated)
      await queryClient.invalidateQueries({ queryKey: accountsQueryOptions.queryKey, exact: true })
      toast.add({ title: 'Сохранено' })
    },
  })
  const fields = save.error instanceof ApiError ? save.error.fields : {}
  const dirty = label !== (account.label ?? '') || note !== (account.note ?? '')

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        save.mutate()
      }}
    >
      <FieldGroup>
        <Field data-invalid={!!fields.label || undefined}>
          <FieldLabel htmlFor="account-label">Метка</FieldLabel>
          <Input id="account-label" maxLength={64} value={label} onChange={(e) => setLabel(e.target.value)} aria-invalid={!!fields.label || undefined} />
          <FieldDescription>Показывается вместо телефона в списках и уведомлениях панели.</FieldDescription>
          {fields.label && <FieldError>{fields.label}</FieldError>}
        </Field>
        <Field data-invalid={!!fields.note || undefined}>
          <FieldLabel htmlFor="account-note">Заметка</FieldLabel>
          <Textarea id="account-note" maxLength={2000} rows={3} value={note} onChange={(e) => setNote(e.target.value)} aria-invalid={!!fields.note || undefined} />
          {fields.note && <FieldError>{fields.note}</FieldError>}
        </Field>
        {save.error && !Object.keys(fields).length && <FieldError>{save.error.message}</FieldError>}
        <Field orientation="horizontal">
          <Button type="submit" disabled={!dirty || save.isPending}>
            Сохранить
          </Button>
        </Field>
      </FieldGroup>
    </form>
  )
}
