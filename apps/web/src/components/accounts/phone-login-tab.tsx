import * as React from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import type { PhoneLoginState } from '@workspace/shared/accounts'
import { Alert, AlertDescription, AlertTitle } from '@workspace/ui/components/alert'
import { Button } from '@workspace/ui/components/button'
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from '@workspace/ui/components/field'
import { Input } from '@workspace/ui/components/input'
import { Spinner } from '@workspace/ui/components/spinner'
import { toast } from '@workspace/ui/components/toast'
import { PasswordInput } from '@/components/password-input'
import { accountsQueryOptions, freeProxies } from '@/lib/accounts'
import { api } from '@/lib/api'
import { useAppEvent } from '@/lib/app-events'
import { proxiesQueryOptions } from '@/lib/proxies'
import { RouteSelect } from './route-select'

interface PhoneProgress {
  state: PhoneLoginState
  deliveryType?: string
  codeLength?: number
  nextType?: string
  retryAfterSec?: number
  hint?: string
  message?: string
  accountId?: string
}

const FINISHED: PhoneLoginState[] = ['done', 'failed', 'expired', 'cancelled']

/** Where Telegram sent the code, as the admin reads it. */
const DELIVERY: Record<string, string> = {
  app: 'в приложение Telegram — сообщением от «Telegram»',
  sms: 'по SMS',
  sms_word: 'по SMS',
  sms_phrase: 'по SMS',
  firebase: 'по SMS',
  call: 'звонком — код продиктуют',
  flash_call: 'звонком — код в последних цифрах номера',
  missed_call: 'пропущенным звонком — код в последних цифрах номера',
  email: 'на почту',
  fragment: 'в Fragment',
}
const RESEND: Record<string, string> = {
  sms: 'Отправить по SMS',
  call: 'Позвонить',
  flash_call: 'Позвонить',
  missed_call: 'Позвонить',
  email: 'Отправить на почту',
  fragment: 'Отправить в Fragment',
}

/** Seconds left until `until`, ticking until it passes. */
function useSecondsLeft(until: number | null): number {
  const [now, setNow] = React.useState(() => Date.now())
  React.useEffect(() => {
    if (until === null) return
    const timer = setInterval(() => {
      const current = Date.now()
      setNow(current)
      if (current >= until) clearInterval(timer)
    }, 250)
    return () => clearInterval(timer)
  }, [until])
  return until === null ? 0 : Math.max(0, Math.ceil((until - now) / 1000))
}

/** Login by phone number: the code arrives in the account's open apps (Telegram Desktop works), then 2FA. */
export function PhoneLoginTab({ onDone }: { onDone: () => void }) {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const proxies = useQuery(proxiesQueryOptions)
  const free = freeProxies(proxies.data?.items ?? [])
  const [route, setRoute] = React.useState<string | null>(null)
  const [phone, setPhone] = React.useState('')
  const [loginId, setLoginId] = React.useState<string | null>(null)
  const [progress, setProgress] = React.useState<PhoneProgress | null>(null)
  const [delivery, setDelivery] = React.useState<PhoneProgress | null>(null)
  const [resendAt, setResendAt] = React.useState<number | null>(null)
  const [code, setCode] = React.useState('')
  const [password, setPassword] = React.useState('')
  // a resend asked for and not answered yet: no second request from a double click
  const [resendPending, setResendPending] = React.useState(false)
  // «напрямую» only by an explicit choice: with no free proxy the admin has to pick it
  const effectiveRoute = route ?? free[0]?.id ?? null
  // the worker may answer before POST /phone-login does: keep such events until the id is known
  const early = React.useRef(new Map<string, PhoneProgress>())
  const secondsLeft = useSecondsLeft(resendAt)

  const apply = (event: PhoneProgress) => {
    setProgress(event)
    if (event.deliveryType) {
      setResendPending(false)
      setDelivery(event)
      if (event.state === 'code_sent') setResendAt(Date.now() + (event.retryAfterSec ?? 0) * 1000)
    }
  }

  const start = useMutation({
    mutationFn: () => api<{ loginId: string }>('/phone-login', { method: 'POST', json: { phone, proxyId: effectiveRoute === 'direct' ? null : effectiveRoute } }),
    onSuccess: ({ loginId }) => {
      setLoginId(loginId)
      const first = early.current.get(loginId)
      if (first) apply(first)
      early.current.clear()
    },
  })
  const sendCode = useMutation({
    mutationFn: () => api(`/phone-login/${loginId}/code`, { method: 'POST', json: { code } }),
    onSuccess: () => setCode(''),
  })
  const sendPassword = useMutation({
    mutationFn: () => api(`/phone-login/${loginId}/password`, { method: 'POST', json: { password } }),
    onSuccess: () => setPassword(''),
  })
  const resend = useMutation({
    mutationFn: () => api(`/phone-login/${loginId}/resend`, { method: 'POST' }),
    onMutate: () => setResendPending(true),
    onError: () => setResendPending(false),
  })

  useAppEvent((event) => {
    if (event.type !== 'phone.update') return
    if (event.loginId !== loginId) {
      if (start.isPending) early.current.set(event.loginId, event)
      return
    }
    apply(event)
    if (event.state === 'done') {
      void queryClient.invalidateQueries({ queryKey: accountsQueryOptions.queryKey })
      toast.add({ title: 'Аккаунт добавлен по номеру' })
      onDone()
      if (event.accountId) void navigate({ to: '/accounts/$id', params: { id: event.accountId } })
    }
  })

  // closing the dialog mid-login cancels it on the worker
  const live = loginId !== null && (progress === null || !FINISHED.includes(progress.state))
  const liveRef = React.useRef({ live, loginId })
  React.useEffect(() => {
    liveRef.current = { live, loginId }
  })
  React.useEffect(
    () => () => {
      if (liveRef.current.live) void api(`/phone-login/${liveRef.current.loginId}`, { method: 'DELETE' }).catch(() => {})
    },
    [],
  )

  const reset = () => {
    setLoginId(null)
    setProgress(null)
    setDelivery(null)
    setResendAt(null)
    setCode('')
    setPassword('')
    start.reset()
  }

  if (!loginId || !progress) {
    return (
      <form
        className="flex flex-col gap-6"
        onSubmit={(e) => {
          e.preventDefault()
          start.mutate()
        }}
      >
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="phone-route">Подключение</FieldLabel>
            <RouteSelect
              id="phone-route"
              value={effectiveRoute}
              onChange={setRoute}
              proxies={free}
              special={[{ value: 'direct', label: 'Напрямую, без прокси' }]}
              placeholder="Свободных прокси нет — выберите вариант"
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="phone-number">Номер телефона</FieldLabel>
            <Input id="phone-number" type="tel" inputMode="tel" autoComplete="off" placeholder="+7 700 123 45 67" value={phone} onChange={(e) => setPhone(e.target.value)} />
            <FieldDescription>
              Код придёт в открытые приложения Telegram этого аккаунта — подойдёт и Telegram Desktop. Нужен свой api_id (Настройки → Telegram).
            </FieldDescription>
          </Field>
        </FieldGroup>
        {start.error && (
          <Alert variant="destructive">
            <AlertDescription>{start.error.message}</AlertDescription>
          </Alert>
        )}
        <div className="flex justify-end">
          <Button type="submit" disabled={!phone.trim() || effectiveRoute === null || start.isPending || (start.isSuccess && !progress)}>
            {(start.isPending || (start.isSuccess && !progress)) && <Spinner data-icon="inline-start" />}
            Получить код
          </Button>
        </div>
      </form>
    )
  }

  if (progress.state === 'failed' || progress.state === 'expired' || progress.state === 'cancelled') {
    return (
      <div className="flex flex-col gap-4">
        <Alert variant="destructive">
          <AlertTitle>{progress.state === 'expired' ? 'Время на вход истекло' : progress.state === 'cancelled' ? 'Вход отменён' : 'Не удалось войти'}</AlertTitle>
          {progress.message && <AlertDescription>{progress.message}</AlertDescription>}
        </Alert>
        <div className="flex justify-end">
          <Button onClick={reset}>Начать заново</Button>
        </div>
      </div>
    )
  }

  if (progress.state === 'password_needed' || progress.state === 'password_invalid') {
    const invalid = progress.state === 'password_invalid'
    return (
      <form
        className="flex flex-col gap-6"
        onSubmit={(e) => {
          e.preventDefault()
          sendPassword.mutate()
        }}
      >
        <Field data-invalid={invalid ? true : undefined}>
          <FieldLabel htmlFor="phone-password">Облачный пароль</FieldLabel>
          <PasswordInput id="phone-password" autoFocus autoComplete="off" required value={password} onChange={(e) => setPassword(e.target.value)} aria-invalid={invalid ? true : undefined} />
          {progress.hint && <FieldDescription>Подсказка: {progress.hint}</FieldDescription>}
          {invalid && <FieldError>Неверный пароль — попробуйте ещё раз</FieldError>}
        </Field>
        <div className="flex justify-end">
          <Button type="submit" disabled={!password || sendPassword.isPending}>
            {sendPassword.isPending && <Spinner data-icon="inline-start" />}
            Войти
          </Button>
        </div>
      </form>
    )
  }

  if (progress.state === 'done') {
    return (
      <div className="flex h-40 items-center justify-center">
        <Spinner />
      </div>
    )
  }

  // the code: code_sent, code_invalid, code_expired
  const where = delivery?.deliveryType ? (DELIVERY[delivery.deliveryType] ?? delivery.deliveryType) : null
  const nextType = delivery?.nextType ?? 'none'
  const error = progress.state === 'code_invalid' ? 'Неверный код' : progress.state === 'code_expired' ? 'Код истёк — запросите новый' : null
  return (
    <form
      className="flex flex-col gap-6"
      onSubmit={(e) => {
        e.preventDefault()
        sendCode.mutate()
      }}
    >
      {where && <p className="text-sm">Код отправлен {where}</p>}
      {progress.message && <p className="text-muted-foreground text-sm">{progress.message}</p>}
      <Field data-invalid={error ? true : undefined}>
        <FieldLabel htmlFor="phone-code">Код</FieldLabel>
        <Input
          id="phone-code"
          autoFocus
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={delivery?.codeLength ? delivery.codeLength + 4 : undefined}
          value={code}
          onChange={(e) => setCode(e.target.value)}
          aria-invalid={error ? true : undefined}
        />
        {delivery?.codeLength ? <FieldDescription>Код из {delivery.codeLength} цифр</FieldDescription> : null}
        {error && <FieldError>{error}</FieldError>}
      </Field>
      <div className="flex flex-wrap justify-end gap-2">
        {progress.state === 'code_expired' ? (
          // an expired code cannot be resent: the worker asks Telegram for a fresh one
          <Button type="button" variant="ghost" disabled={resendPending} onClick={() => resend.mutate()}>
            Запросить новый код
          </Button>
        ) : (
          nextType !== 'none' && (
            <Button type="button" variant="ghost" disabled={secondsLeft > 0 || resendPending} onClick={() => resend.mutate()}>
              {RESEND[nextType] ?? 'Отправить ещё раз'}
              {secondsLeft > 0 ? ` через ${secondsLeft} с` : ''}
            </Button>
          )
        )}
        <Button type="submit" disabled={!code.trim() || sendCode.isPending}>
          {sendCode.isPending && <Spinner data-icon="inline-start" />}
          Войти
        </Button>
      </div>
    </form>
  )
}
