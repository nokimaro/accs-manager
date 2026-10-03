import * as React from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { AccountDto, EmailCodeNeeded } from '@workspace/shared/accounts'
import { Alert, AlertDescription, AlertTitle } from '@workspace/ui/components/alert'
import { Button } from '@workspace/ui/components/button'
import { Spinner } from '@workspace/ui/components/spinner'
import { toast } from '@workspace/ui/components/toast'
import { cloudPasswordInfoQueryOptions } from '@/lib/accounts'
import { api, ApiError } from '@/lib/api'
import { formatDateTime } from '@/lib/format'
import { EmailCodeDialog, SetPasswordDialog, VerifyPasswordDialog } from './cloud-password-dialogs'

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[10rem_1fr] gap-2 py-1.5 text-sm">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </div>
  )
}

/** The account's cloud (2FA) password: what Telegram says, the stored one on request, set / change / verify. */
export function CloudPasswordCard({ account }: { account: AccountDto }) {
  const queryClient = useQueryClient()
  const connected = account.status === 'active' || account.status === 'frozen'
  const query = cloudPasswordInfoQueryOptions(account.id)
  const info = useQuery({ ...query, enabled: connected })
  const [revealed, setRevealed] = React.useState<string | null>(null)
  const [dialog, setDialog] = React.useState<'verify' | 'set' | 'email' | null>(null)
  const [emailStep, setEmailStep] = React.useState<EmailCodeNeeded | null>(null)
  const refresh = () => {
    setRevealed(null)
    void queryClient.invalidateQueries({ queryKey: query.queryKey })
  }

  const reveal = useMutation({
    mutationFn: () => api<{ password: string }>(`/accounts/${account.id}/cloud-password`),
    onSuccess: ({ password }) => setRevealed(password),
    onError: (err) => toast.add({ title: 'Не удалось показать пароль', description: err instanceof ApiError ? err.message : String(err) }),
  })

  if (!connected) return <p className="text-muted-foreground text-sm">Аккаунт не подключён — состояние облачного пароля недоступно</p>
  if (info.isPending) return <Spinner />
  if (info.error) {
    return (
      <Alert variant="destructive">
        <AlertDescription>{info.error.message}</AlertDescription>
      </Alert>
    )
  }
  const s = info.data

  return (
    <div className="flex flex-col gap-4">
      {s.pendingResetAt && (
        <Alert variant="destructive">
          <AlertTitle>Запрошен сброс облачного пароля</AlertTitle>
          <AlertDescription>
            Сброс сработает {formatDateTime(s.pendingResetAt)}. Если это не вы — отмените его в официальном приложении Telegram (Настройки → Конфиденциальность →
            Облачный пароль).
          </AlertDescription>
        </Alert>
      )}
      <dl className="divide-y">
        <Row label="Облачный пароль">{s.hasPassword ? 'установлен' : 'не установлен'}</Row>
        {s.hasPassword && <Row label="Подсказка">{s.hint || '—'}</Row>}
        {s.hasPassword && (
          <Row label="Пароль">
            {s.known ? (
              <span className="flex flex-wrap items-center gap-2">
                <span className="font-mono">{revealed ?? '••••••••'}</span>
                {revealed === null ? (
                  <Button variant="outline" size="sm" disabled={reveal.isPending} onClick={() => reveal.mutate()}>
                    Показать
                  </Button>
                ) : (
                  <Button variant="outline" size="sm" onClick={() => setRevealed(null)}>
                    Скрыть
                  </Button>
                )}
              </span>
            ) : (
              <span className="flex flex-wrap items-center gap-2">
                <span className="text-muted-foreground">неизвестен панели</span>
                <Button variant="outline" size="sm" onClick={() => setDialog('verify')}>
                  Указать текущий
                </Button>
              </span>
            )}
          </Row>
        )}
        {(s.hasPassword || s.unconfirmedEmailPattern) && (
          <Row label="Почта восстановления">
            <span className="flex flex-col gap-1">
              <span>{s.recoveryEmail ?? (s.hasRecovery ? 'привязана' : 'не привязана')}</span>
              {s.unconfirmedEmailPattern && (
                <span className="flex flex-wrap items-center gap-2">
                  <span className="text-muted-foreground">ожидает подтверждения: {s.unconfirmedEmailPattern}</span>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setEmailStep({ pattern: s.unconfirmedEmailPattern, length: null })
                      setDialog('email')
                    }}
                  >
                    Ввести код из письма
                  </Button>
                </span>
              )}
            </span>
          </Row>
        )}
      </dl>
      <div>
        <Button variant="outline" onClick={() => setDialog('set')}>
          {s.hasPassword ? 'Сменить пароль' : 'Установить пароль'}
        </Button>
      </div>

      <VerifyPasswordDialog accountId={account.id} open={dialog === 'verify'} onOpenChange={(open) => setDialog(open ? 'verify' : null)} onChanged={refresh} />
      <SetPasswordDialog
        accountId={account.id}
        info={s}
        open={dialog === 'set'}
        onOpenChange={(open) => setDialog(open ? 'set' : null)}
        onChanged={refresh}
        onEmailCode={(step) => {
          setEmailStep(step)
          setDialog('email')
        }}
      />
      <EmailCodeDialog accountId={account.id} step={emailStep} open={dialog === 'email'} onOpenChange={(open) => setDialog(open ? 'email' : null)} onChanged={refresh} />
    </div>
  )
}
