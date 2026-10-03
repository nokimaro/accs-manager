import * as React from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { ProxyType } from '@workspace/shared/proxies'
import { Button } from '@workspace/ui/components/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@workspace/ui/components/dialog'
import { Field, FieldError, FieldGroup, FieldLabel } from '@workspace/ui/components/field'
import { Input } from '@workspace/ui/components/input'
import { Spinner } from '@workspace/ui/components/spinner'
import { toast } from '@workspace/ui/components/toast'
import { PlusIcon } from 'lucide-react'
import { PasswordInput } from '@/components/password-input'
import { api, ApiError } from '@/lib/api'
import { proxiesQueryOptions } from '@/lib/proxies'
import { ProxyTypeSelect } from './proxy-type-select'

const empty = { type: 'socks5' as ProxyType, host: '', port: '', username: '', password: '', tag: '' }

export function AddProxyDialog() {
  const queryClient = useQueryClient()
  const [open, setOpen] = React.useState(false)
  const [form, setForm] = React.useState(empty)
  const set = (patch: Partial<typeof empty>) => setForm((f) => ({ ...f, ...patch }))
  const mutation = useMutation({
    mutationFn: () =>
      api('/proxies', {
        method: 'POST',
        json: {
          type: form.type,
          host: form.host,
          port: form.port,
          ...(form.username ? { username: form.username } : {}),
          ...(form.password ? { password: form.password } : {}),
          ...(form.tag ? { tag: form.tag } : {}),
        },
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: proxiesQueryOptions.queryKey })
      toast.add({ title: 'Прокси добавлен', description: `${form.host}:${form.port} — проверка запущена` })
      handleOpenChange(false)
    },
    onError: (err) => {
      if (!(err instanceof ApiError) || (err.status !== 400 && err.status !== 409)) {
        toast.add({ title: 'Не удалось добавить прокси', description: err instanceof Error ? err.message : String(err) })
      }
    },
  })
  const err = mutation.error instanceof ApiError ? mutation.error : null
  const fields = err?.fields ?? {}
  const hostError = fields.host ?? (err?.status === 409 ? err.message : undefined)

  function handleOpenChange(next: boolean) {
    // never keep a typed password after the dialog closes
    if (!next) {
      setForm(empty)
      mutation.reset()
    }
    setOpen(next)
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger render={<Button />}>
        <PlusIcon data-icon="inline-start" />
        Добавить
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
            <DialogTitle>Новый прокси</DialogTitle>
            <DialogDescription>Сразу после добавления прокси проверяется подключением к Telegram.</DialogDescription>
          </DialogHeader>
          <FieldGroup>
            <div className="grid grid-cols-[8rem_1fr_6rem] gap-3">
              <Field>
                <FieldLabel htmlFor="proxy-type">Тип</FieldLabel>
                <ProxyTypeSelect id="proxy-type" value={form.type} onChange={(type) => set({ type })} />
              </Field>
              <Field data-invalid={hostError ? true : undefined}>
                <FieldLabel htmlFor="proxy-host">Адрес</FieldLabel>
                <Input id="proxy-host" required placeholder="194.53.188.22" value={form.host} onChange={(e) => set({ host: e.target.value })} aria-invalid={hostError ? true : undefined} />
              </Field>
              <Field data-invalid={fields.port ? true : undefined}>
                <FieldLabel htmlFor="proxy-port">Порт</FieldLabel>
                <Input id="proxy-port" required inputMode="numeric" value={form.port} onChange={(e) => set({ port: e.target.value })} aria-invalid={fields.port ? true : undefined} />
              </Field>
            </div>
            {(hostError || fields.port) && <FieldError>{hostError ?? fields.port}</FieldError>}
            <div className="grid grid-cols-2 gap-3">
              <Field>
                <FieldLabel htmlFor="proxy-username">Логин</FieldLabel>
                <Input id="proxy-username" autoComplete="off" value={form.username} onChange={(e) => set({ username: e.target.value })} />
              </Field>
              <Field>
                <FieldLabel htmlFor="proxy-password">Пароль</FieldLabel>
                <PasswordInput id="proxy-password" autoComplete="new-password" value={form.password} onChange={(e) => set({ password: e.target.value })} />
              </Field>
            </div>
            <Field>
              <FieldLabel htmlFor="proxy-tag">Метка</FieldLabel>
              <Input id="proxy-tag" placeholder="необязательно" value={form.tag} onChange={(e) => set({ tag: e.target.value })} />
            </Field>
          </FieldGroup>
          <DialogFooter>
            <Button type="submit" disabled={mutation.isPending}>
              {mutation.isPending && <Spinner data-icon="inline-start" />}
              Добавить
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
