import * as React from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { ConfirmImportInput, ConfirmImportResult, ImportBatchDto } from '@workspace/shared/accounts'
import { Alert, AlertDescription, AlertTitle } from '@workspace/ui/components/alert'
import { Badge } from '@workspace/ui/components/badge'
import { Button } from '@workspace/ui/components/button'
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from '@workspace/ui/components/field'
import { Input } from '@workspace/ui/components/input'
import { Spinner } from '@workspace/ui/components/spinner'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@workspace/ui/components/table'
import { toast } from '@workspace/ui/components/toast'
import { WandSparklesIcon } from 'lucide-react'
import { PasswordInput } from '@/components/password-input'
import { accountsQueryOptions, freeProxies, REUSE_CHOICE, usableProxies } from '@/lib/accounts'
import { api, ApiError } from '@/lib/api'
import { proxiesQueryOptions } from '@/lib/proxies'
import { RouteSelect, type RouteChoice } from './route-select'

const SPECIAL = [
  { value: 'auto', label: 'Свободный прокси автоматически' },
  REUSE_CHOICE,
  { value: 'direct', label: 'Напрямую, без прокси' },
  { value: 'skip', label: 'Не добавлять' },
]
const DECISIONS = new Set(SPECIAL.map((s) => s.value))

export function ImportTdataTab({ onDone }: { onDone: () => void }) {
  const queryClient = useQueryClient()
  const [file, setFile] = React.useState<File | null>(null)
  const [passcode, setPasscode] = React.useState('')
  const [choices, setChoices] = React.useState<Record<string, RouteChoice>>({})
  const proxies = useQuery(proxiesQueryOptions)
  const usable = usableProxies(proxies.data?.items ?? [])
  const free = freeProxies(proxies.data?.items ?? [])
  const special = usable.length > 0 ? SPECIAL : SPECIAL.filter((s) => s.value !== REUSE_CHOICE.value)

  const upload = useMutation({
    mutationFn: () => {
      const form = new FormData()
      form.set('file', file!)
      if (passcode) form.set('passcode', passcode)
      return api<ImportBatchDto>('/imports', { method: 'POST', body: form })
    },
    onSuccess: (batch) => {
      // duplicates can only be skipped; «direct» is never chosen for the admin
      setChoices(Object.fromEntries(batch.items.map((i) => [i.id, i.duplicateOf || free.length === 0 ? 'skip' : 'auto'])))
    },
  })
  const batch = upload.data

  const confirm = useMutation({
    mutationFn: () => {
      const items: ConfirmImportInput['items'] = batch!.items.map((i) => {
        const choice = choices[i.id] ?? 'skip'
        if (choice === 'auto' || choice === 'reuse' || choice === 'direct' || choice === 'skip') return { id: i.id, decision: choice }
        return { id: i.id, decision: 'proxy', proxyId: choice }
      })
      return api<ConfirmImportResult>(`/imports/${batch!.id}/confirm`, { method: 'POST', json: { items } })
    },
    onSuccess: async (result) => {
      await queryClient.invalidateQueries({ queryKey: accountsQueryOptions.queryKey })
      await queryClient.invalidateQueries({ queryKey: proxiesQueryOptions.queryKey })
      toast.add({ title: `Добавлено аккаунтов: ${result.created}`, description: 'Подключение и проверка займут несколько секунд' })
      onDone()
    },
  })

  const uploadError = upload.error instanceof ApiError ? upload.error : null
  const passcodeError = uploadError?.body?.error === 'passcode_required' || uploadError?.body?.error === 'passcode_invalid' ? uploadError.message : undefined
  // a proxy picked by hand is no longer free for «auto» (several accounts may share it)
  const chosen = new Set(batch ? batch.items.map((i) => choices[i.id]).filter((c): c is string => !!c && !DECISIONS.has(c)) : [])
  const autoCount = batch ? batch.items.filter((i) => choices[i.id] === 'auto').length : 0
  const notEnough = autoCount > free.filter((p) => !chosen.has(p.id)).length
  const toAdd = batch ? batch.items.filter((i) => choices[i.id] && choices[i.id] !== 'skip').length : 0

  if (!batch) {
    return (
      <form
        className="flex flex-col gap-6"
        onSubmit={(e) => {
          e.preventDefault()
          upload.mutate()
        }}
      >
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="tdata-file">Архив tdata (.zip)</FieldLabel>
            <Input id="tdata-file" type="file" accept=".zip,application/zip" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
            <FieldDescription>Папку tdata можно положить в архив на любой глубине; аккаунтов внутри может быть несколько.</FieldDescription>
          </Field>
          <Field data-invalid={passcodeError ? true : undefined}>
            <FieldLabel htmlFor="tdata-passcode">Локальный код-пароль</FieldLabel>
            <PasswordInput id="tdata-passcode" autoComplete="off" value={passcode} onChange={(e) => setPasscode(e.target.value)} aria-invalid={passcodeError ? true : undefined} />
            <FieldDescription>Только если в Telegram Desktop включён код-пароль на приложение.</FieldDescription>
            {passcodeError && <FieldError>{passcodeError}</FieldError>}
          </Field>
        </FieldGroup>
        {upload.error && !passcodeError && (
          <Alert variant="destructive">
            <AlertTitle>Не удалось прочитать архив</AlertTitle>
            <AlertDescription>{upload.error.message}</AlertDescription>
          </Alert>
        )}
        <Alert>
          <AlertTitle>После переноса этот Telegram Desktop больше не запускайте</AlertTitle>
          <AlertDescription>Одна сессия с двух мест одновременно — и Telegram отзовёт её на обоих.</AlertDescription>
        </Alert>
        <div className="flex justify-end">
          <Button type="submit" disabled={!file || upload.isPending}>
            {upload.isPending && <Spinner data-icon="inline-start" />}
            Загрузить и проверить
          </Button>
        </div>
      </form>
    )
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-muted-foreground text-sm">
          В архиве {batch.filename} найдено аккаунтов: {batch.items.length}. Выберите, через что каждый будет подключаться.
        </p>
        <Button
          variant="outline"
          size="sm"
          disabled={free.length === 0}
          onClick={() => setChoices(Object.fromEntries(batch.items.map((i) => [i.id, i.duplicateOf ? 'skip' : 'auto'])))}
        >
          <WandSparklesIcon data-icon="inline-start" />
          Раздать автоматически
        </Button>
      </div>
      <div className="overflow-x-auto rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Telegram ID</TableHead>
              <TableHead>DC</TableHead>
              <TableHead>Путь в архиве</TableHead>
              <TableHead>Подключение</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {batch.items.map((item) => (
              <TableRow key={item.id}>
                <TableCell className="font-mono text-xs">
                  {item.tgUserId}
                  {item.duplicateOf && (
                    <Badge variant="outline" className="ml-2">
                      уже в панели
                    </Badge>
                  )}
                </TableCell>
                <TableCell>{item.dcId}</TableCell>
                <TableCell className="text-muted-foreground font-mono text-xs">
                  {item.pathInArchive} #{item.accountIndex}
                </TableCell>
                <TableCell>
                  <RouteSelect
                    aria-label={`Подключение аккаунта ${item.tgUserId}`}
                    value={choices[item.id] ?? 'skip'}
                    onChange={(value) => setChoices((c) => ({ ...c, [item.id]: value }))}
                    proxies={usable}
                    special={item.duplicateOf ? SPECIAL.filter((s) => s.value === 'skip') : special}
                    disabled={!!item.duplicateOf}
                  />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      {free.length === 0 && (
        <Alert>
          <AlertTitle>Свободных рабочих прокси нет</AlertTitle>
          <AlertDescription>
            {usable.length > 0
              ? 'Выберите «Переиспользовать прокси» — аккаунт сядет на прокси, где меньше всего аккаунтов, — или добавьте прокси на странице «Прокси».'
              : 'Добавьте прокси на странице «Прокси» или явно выберите «Напрямую» — тогда Telegram увидит IP сервера.'}
          </AlertDescription>
        </Alert>
      )}
      {notEnough && (
        <Alert variant="destructive">
          <AlertDescription>Для «автоматически» не хватает свободных прокси: нужно {autoCount}. Остальным можно выбрать «Переиспользовать прокси».</AlertDescription>
        </Alert>
      )}
      {confirm.error && (
        <Alert variant="destructive">
          <AlertDescription>{confirm.error.message}</AlertDescription>
        </Alert>
      )}
      <div className="flex justify-end gap-2">
        <Button
          variant="ghost"
          onClick={() => {
            upload.reset()
            setFile(null)
          }}
        >
          Другой архив
        </Button>
        <Button disabled={toAdd === 0 || notEnough || confirm.isPending} onClick={() => confirm.mutate()}>
          {confirm.isPending && <Spinner data-icon="inline-start" />}
          Добавить {toAdd}
        </Button>
      </div>
    </div>
  )
}
