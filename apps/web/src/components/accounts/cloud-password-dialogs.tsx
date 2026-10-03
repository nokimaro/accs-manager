import * as React from 'react'
import { useMutation } from '@tanstack/react-query'
import type { CloudPasswordInfoDto, EmailCodeNeeded } from '@workspace/shared/accounts'
import { Alert, AlertDescription } from '@workspace/ui/components/alert'
import { Button } from '@workspace/ui/components/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@workspace/ui/components/dialog'
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from '@workspace/ui/components/field'
import { Input } from '@workspace/ui/components/input'
import { Spinner } from '@workspace/ui/components/spinner'
import { toast } from '@workspace/ui/components/toast'
import { PasswordInput } from '@/components/password-input'
import { api, ApiError, errorText } from '@/lib/api'

const errorCode = (err: unknown) => (err instanceof ApiError ? (err.body?.error ?? null) : null)
const fieldError = (err: unknown, field: string) => (err instanceof ApiError ? err.fields[field] : undefined)

interface DialogProps {
  accountId: string
  open: boolean
  onOpenChange: (open: boolean) => void
  /** something changed on Telegram's side: re-read the state */
  onChanged: () => void
}

/** «Указать текущий»: Telegram checks the password, then the panel keeps it. */
export function VerifyPasswordDialog({ accountId, open, onOpenChange, onChanged }: DialogProps) {
  const [password, setPassword] = React.useState('')
  const verify = useMutation({
    mutationFn: () => api(`/accounts/${accountId}/cloud-password/verify`, { method: 'POST', json: { password } }),
    onSuccess: () => {
      toast.add({ title: 'Пароль подошёл — панель его запомнила' })
      onChanged()
      onOpenChange(false)
    },
  })
  const close = (next: boolean) => {
    if (!next) {
      setPassword('')
      verify.reset()
    }
    onOpenChange(next)
  }
  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent>
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault()
            verify.mutate()
          }}
        >
          <DialogHeader>
            <DialogTitle>Текущий облачный пароль</DialogTitle>
            <DialogDescription>Telegram проверит пароль; если он верный, панель его запомнит и покажет в карточке.</DialogDescription>
          </DialogHeader>
          <Field data-invalid={verify.error ? true : undefined}>
            <FieldLabel htmlFor="cloud-verify">Пароль</FieldLabel>
            <PasswordInput id="cloud-verify" autoComplete="off" required value={password} onChange={(e) => setPassword(e.target.value)} aria-invalid={verify.error ? true : undefined} />
            {verify.error && <FieldError>{errorText(verify.error, 'password')}</FieldError>}
          </Field>
          <DialogFooter>
            <Button type="submit" disabled={!password || verify.isPending}>
              {verify.isPending && <Spinner data-icon="inline-start" />}
              Проверить
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

/** «Установить» / «Сменить»: new password with a repeat, hint, and an optional recovery email. */
export function SetPasswordDialog({ accountId, info, open, onOpenChange, onChanged, onEmailCode }: DialogProps & { info: CloudPasswordInfoDto; onEmailCode: (step: EmailCodeNeeded) => void }) {
  const askCurrent = info.hasPassword && !info.known
  const empty = { current: '', next: '', repeat: '', hint: '', email: '' }
  const [form, setForm] = React.useState(empty)
  const [mismatch, setMismatch] = React.useState(false)
  const set = (key: keyof typeof empty) => (e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [key]: e.target.value }))

  const save = useMutation({
    mutationFn: () =>
      api<{ ok: true } | { emailCodeNeeded: EmailCodeNeeded }>(`/accounts/${accountId}/cloud-password`, {
        method: 'PUT',
        json: {
          ...(askCurrent ? { currentPassword: form.current } : {}),
          newPassword: form.next,
          ...(form.hint.trim() ? { hint: form.hint.trim() } : {}),
          ...(form.email.trim() ? { email: form.email.trim() } : {}),
        },
      }),
    onSuccess: (result) => {
      onChanged()
      close(false)
      if ('emailCodeNeeded' in result) onEmailCode(result.emailCodeNeeded)
      else toast.add({ title: 'Облачный пароль сохранён' })
    },
    // the card's state was behind (a stored password stopped fitting, or Telegram has one the card did not know):
    // re-read it, and the form asks for the current password
    onError: (err) => {
      const code = errorCode(err)
      if (code === 'stale_password' || code === 'password_unknown') onChanged()
    },
  })
  const close = (next: boolean) => {
    if (!next) {
      setForm(empty)
      setMismatch(false)
      save.reset()
    }
    onOpenChange(next)
  }

  const code = errorCode(save.error)
  const currentError =
    fieldError(save.error, 'currentPassword') ?? (code === 'wrong_password' || code === 'stale_password' || code === 'password_unknown' ? errorText(save.error) : null)
  const newError = fieldError(save.error, 'newPassword') ?? null
  const hintError = fieldError(save.error, 'hint') ?? null
  const emailError = fieldError(save.error, 'email') ?? (code === 'email_invalid' ? errorText(save.error) : null)
  // an error for a field the form does not show (current password not asked) goes to the general message
  const shown = (askCurrent && currentError) || newError || hintError || emailError
  const otherError = save.error && !shown ? errorText(save.error) : null

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent>
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault()
            if (form.next !== form.repeat) {
              setMismatch(true)
              return
            }
            setMismatch(false)
            save.mutate()
          }}
        >
          <DialogHeader>
            <DialogTitle>Новый облачный пароль</DialogTitle>
            <DialogDescription>Пароль двухэтапной проверки аккаунта. Панель сохранит его зашифрованным и покажет в карточке.</DialogDescription>
          </DialogHeader>
          <FieldGroup>
            {askCurrent && (
              <Field data-invalid={currentError ? true : undefined}>
                <FieldLabel htmlFor="cloud-current">Текущий пароль</FieldLabel>
                <PasswordInput id="cloud-current" autoComplete="off" required value={form.current} onChange={set('current')} aria-invalid={currentError ? true : undefined} />
                {currentError && <FieldError>{currentError}</FieldError>}
              </Field>
            )}
            <Field data-invalid={newError ? true : undefined}>
              <FieldLabel htmlFor="cloud-new">Новый пароль</FieldLabel>
              <PasswordInput id="cloud-new" autoComplete="new-password" required value={form.next} onChange={set('next')} aria-invalid={newError ? true : undefined} />
              {newError && <FieldError>{newError}</FieldError>}
            </Field>
            <Field data-invalid={mismatch ? true : undefined}>
              <FieldLabel htmlFor="cloud-repeat">Повтор пароля</FieldLabel>
              <PasswordInput id="cloud-repeat" autoComplete="new-password" required value={form.repeat} onChange={set('repeat')} aria-invalid={mismatch ? true : undefined} />
              {mismatch && <FieldError>Пароли не совпадают</FieldError>}
            </Field>
            <Field data-invalid={hintError ? true : undefined}>
              <FieldLabel htmlFor="cloud-hint">Подсказка</FieldLabel>
              <Input id="cloud-hint" maxLength={128} value={form.hint} onChange={set('hint')} aria-invalid={hintError ? true : undefined} />
              <FieldDescription>Необязательно. Telegram покажет её при вводе пароля.</FieldDescription>
              {hintError && <FieldError>{hintError}</FieldError>}
            </Field>
            <Field data-invalid={emailError ? true : undefined}>
              <FieldLabel htmlFor="cloud-email">Почта для восстановления</FieldLabel>
              <Input id="cloud-email" type="email" autoComplete="off" value={form.email} onChange={set('email')} aria-invalid={emailError ? true : undefined} />
              <FieldDescription>Необязательно. Telegram пришлёт на неё код подтверждения; пусто — почта не меняется.</FieldDescription>
              {emailError && <FieldError>{emailError}</FieldError>}
            </Field>
          </FieldGroup>
          {otherError && (
            <Alert variant="destructive">
              <AlertDescription>{otherError}</AlertDescription>
            </Alert>
          )}
          <DialogFooter>
            <Button type="submit" disabled={!form.next || save.isPending}>
              {save.isPending && <Spinner data-icon="inline-start" />}
              Сохранить
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

/** The code Telegram mailed to the new recovery email: confirm it, send it again, or skip the email. */
export function EmailCodeDialog({ accountId, step, open, onOpenChange, onChanged }: DialogProps & { step: EmailCodeNeeded | null }) {
  const [code, setCode] = React.useState('')
  const act = useMutation({
    mutationFn: (action: 'confirm' | 'resend' | 'cancel') =>
      api(`/accounts/${accountId}/cloud-password/email`, { method: 'POST', json: action === 'confirm' ? { action, code } : { action } }),
    onSuccess: (_, action) => {
      if (action === 'resend') {
        toast.add({ title: 'Письмо отправлено ещё раз' })
        return
      }
      toast.add({ title: action === 'confirm' ? 'Почта подтверждена' : 'Почта не привязана' })
      onChanged()
      close(false)
    },
  })
  const close = (next: boolean) => {
    if (!next) {
      setCode('')
      act.reset()
    }
    onOpenChange(next)
  }
  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent>
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault()
            act.mutate('confirm')
          }}
        >
          <DialogHeader>
            <DialogTitle>Код из письма</DialogTitle>
            <DialogDescription>
              Telegram отправил код на {step?.pattern ?? 'почту для восстановления'}. Введите его, чтобы привязать почту и завершить настройку
              пароля; что действует сейчас, карточка покажет после подтверждения или пропуска.
            </DialogDescription>
          </DialogHeader>
          <Field data-invalid={act.error ? true : undefined}>
            <FieldLabel htmlFor="cloud-email-code">Код</FieldLabel>
            <Input id="cloud-email-code" inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} aria-invalid={act.error ? true : undefined} />
            {step?.length ? <FieldDescription>Код из {step.length} цифр</FieldDescription> : null}
            {act.error && <FieldError>{errorText(act.error, 'code')}</FieldError>}
          </Field>
          <DialogFooter>
            <Button type="button" variant="ghost" disabled={act.isPending} onClick={() => act.mutate('cancel')}>
              Пропустить
            </Button>
            <Button type="button" variant="outline" disabled={act.isPending} onClick={() => act.mutate('resend')}>
              Отправить ещё раз
            </Button>
            <Button type="submit" disabled={!code.trim() || act.isPending}>
              {act.isPending && <Spinner data-icon="inline-start" />}
              Подтвердить
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
