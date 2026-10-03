import * as React from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import type { QrState } from '@workspace/shared/accounts'
import { Alert, AlertDescription, AlertTitle } from '@workspace/ui/components/alert'
import { Button } from '@workspace/ui/components/button'
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from '@workspace/ui/components/field'
import { Spinner } from '@workspace/ui/components/spinner'
import { toast } from '@workspace/ui/components/toast'
import QRCode from 'qrcode'
import { PasswordInput } from '@/components/password-input'
import { accountsQueryOptions, freeProxies } from '@/lib/accounts'
import { api } from '@/lib/api'
import { useAppEvent } from '@/lib/app-events'
import { proxiesQueryOptions } from '@/lib/proxies'
import { RouteSelect } from './route-select'

interface QrProgress {
  state: QrState
  url?: string
  hint?: string
  message?: string
  accountId?: string
}

const FINISHED: QrState[] = ['done', 'failed', 'expired', 'cancelled']

export function QrLoginTab({ onDone }: { onDone: () => void }) {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const proxies = useQuery(proxiesQueryOptions)
  const free = freeProxies(proxies.data?.items ?? [])
  const [route, setRoute] = React.useState<string | null>(null)
  const [qrId, setQrId] = React.useState<string | null>(null)
  const [progress, setProgress] = React.useState<QrProgress | null>(null)
  const [image, setImage] = React.useState<string | null>(null)
  const [password, setPassword] = React.useState('')
  // «напрямую» only by an explicit choice: with no free proxy the admin has to pick it
  const effectiveRoute = route ?? free[0]?.id ?? null
  // the worker may publish the first QR before POST /qr answers: keep such events until the id is known
  const early = React.useRef(new Map<string, QrProgress>())

  const start = useMutation({
    mutationFn: () => api<{ qrId: string }>('/qr', { method: 'POST', json: { proxyId: effectiveRoute === 'direct' ? null : effectiveRoute } }),
    onSuccess: ({ qrId }) => {
      setQrId(qrId)
      setProgress(early.current.get(qrId) ?? { state: 'waiting' })
      early.current.clear()
    },
  })
  const sendPassword = useMutation({
    mutationFn: () => api(`/qr/${qrId}/password`, { method: 'POST', json: { password } }),
    onSuccess: () => setPassword(''),
  })

  useAppEvent((event) => {
    if (event.type !== 'qr.update') return
    if (event.qrId !== qrId) {
      if (start.isPending) early.current.set(event.qrId, event)
      return
    }
    setProgress(event)
    if (event.state === 'done') {
      void queryClient.invalidateQueries({ queryKey: accountsQueryOptions.queryKey })
      toast.add({ title: 'Аккаунт добавлен по QR' })
      onDone()
      if (event.accountId) void navigate({ to: '/accounts/$id', params: { id: event.accountId } })
    }
  })

  React.useEffect(() => {
    if (!progress?.url) return
    let cancelled = false
    void QRCode.toDataURL(progress.url, { margin: 1, width: 240 }).then((data) => !cancelled && setImage(data))
    return () => {
      cancelled = true
    }
  }, [progress?.url])

  // closing the dialog mid-login cancels it on the worker
  const live = qrId !== null && progress !== null && !FINISHED.includes(progress.state)
  const liveRef = React.useRef({ live, qrId })
  React.useEffect(() => {
    liveRef.current = { live, qrId }
  })
  React.useEffect(
    () => () => {
      if (liveRef.current.live) void api(`/qr/${liveRef.current.qrId}`, { method: 'DELETE' }).catch(() => {})
    },
    [],
  )

  const reset = () => {
    setQrId(null)
    setProgress(null)
    setImage(null)
    start.reset()
  }

  if (!qrId || !progress) {
    return (
      <div className="flex flex-col gap-6">
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="qr-route">Подключение</FieldLabel>
            <RouteSelect
              id="qr-route"
              value={effectiveRoute}
              onChange={setRoute}
              proxies={free}
              special={[{ value: 'direct', label: 'Напрямую, без прокси' }]}
              placeholder="Свободных прокси нет — выберите вариант"
            />
            <FieldDescription>Новая сессия сразу пойдёт через выбранный прокси. Нужен свой api_id (Настройки → Telegram).</FieldDescription>
          </Field>
        </FieldGroup>
        {start.error && (
          <Alert variant="destructive">
            <AlertDescription>{start.error.message}</AlertDescription>
          </Alert>
        )}
        <div className="flex justify-end">
          <Button disabled={effectiveRoute === null || start.isPending} onClick={() => start.mutate()}>
            {start.isPending && <Spinner data-icon="inline-start" />}
            Показать QR-код
          </Button>
        </div>
      </div>
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
          <FieldLabel htmlFor="qr-password">Пароль двухэтапной проверки</FieldLabel>
          <PasswordInput id="qr-password" autoFocus autoComplete="off" required value={password} onChange={(e) => setPassword(e.target.value)} aria-invalid={invalid ? true : undefined} />
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

  return (
    <div className="flex flex-col items-center gap-4 text-center">
      {progress.state === 'scanned' || progress.state === 'done' || !image ? (
        <div className="flex h-60 flex-col items-center justify-center gap-3">
          <Spinner />
          <p className="text-muted-foreground text-sm">{progress.state === 'scanned' ? 'QR отсканирован — подтвердите вход в Telegram' : 'Готовим QR-код…'}</p>
        </div>
      ) : (
        <img src={image} alt="QR-код для входа в Telegram" className="size-60 rounded-lg bg-white p-2" />
      )}
      <p className="text-muted-foreground max-w-sm text-sm">Откройте Telegram на телефоне: Настройки → Устройства → Подключить устройство — и наведите камеру на код.</p>
    </div>
  )
}
