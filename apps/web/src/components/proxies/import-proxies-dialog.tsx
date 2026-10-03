import * as React from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { ImportProxiesPreview, ImportProxiesResult, ProxyType } from '@workspace/shared/proxies'
import { Alert, AlertDescription, AlertTitle } from '@workspace/ui/components/alert'
import { Badge } from '@workspace/ui/components/badge'
import { Button } from '@workspace/ui/components/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@workspace/ui/components/dialog'
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@workspace/ui/components/field'
import { Input } from '@workspace/ui/components/input'
import { Spinner } from '@workspace/ui/components/spinner'
import { Textarea } from '@workspace/ui/components/textarea'
import { toast } from '@workspace/ui/components/toast'
import { ListPlusIcon } from 'lucide-react'
import { api, ApiError } from '@/lib/api'
import { proxiesQueryOptions } from '@/lib/proxies'
import { ProxyTypeSelect } from './proxy-type-select'

const SHOWN_PROBLEMS = 8

export function ImportProxiesDialog() {
  const queryClient = useQueryClient()
  const [open, setOpen] = React.useState(false)
  const [text, setText] = React.useState('')
  const [defaultType, setDefaultType] = React.useState<ProxyType>('socks5')
  const [tag, setTag] = React.useState('')
  const body = () => ({ text, defaultType, ...(tag ? { tag } : {}) })

  const preview = useMutation({ mutationFn: () => api<ImportProxiesPreview>('/proxies/import/preview', { method: 'POST', json: body() }) })
  const commit = useMutation({
    mutationFn: () => api<ImportProxiesResult>('/proxies/import', { method: 'POST', json: body() }),
    onSuccess: async (result) => {
      await queryClient.invalidateQueries({ queryKey: proxiesQueryOptions.queryKey })
      toast.add({ title: `Добавлено прокси: ${result.created}`, description: result.skipped ? `Пропущено: ${result.skipped}` : 'Проверка начнётся в течение минуты' })
      handleOpenChange(false)
    },
    onError: (err) => toast.add({ title: 'Не удалось импортировать', description: err instanceof ApiError ? err.message : String(err) }),
  })

  function handleOpenChange(next: boolean) {
    // the pasted list carries passwords: drop it when the dialog closes
    if (!next) {
      setText('')
      setTag('')
      preview.reset()
      commit.reset()
    }
    setOpen(next)
  }

  const result = preview.data
  const problems = result ? [...result.errors.map((e) => ({ ...e, kind: e.reason })), ...result.duplicates.map((d) => ({ ...d, kind: d.reason === 'exists' ? 'уже в пуле' : 'повтор в списке' }))].sort((a, b) => a.line - b.line) : []

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger render={<Button variant="outline" />}>
        <ListPlusIcon data-icon="inline-start" />
        Импорт списка
      </DialogTrigger>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Импорт списка прокси</DialogTitle>
          <DialogDescription>По одному на строку: socks5://логин:пароль@host:port, http://host:port, host:port, host:port:логин:пароль или логин:пароль@host:port.</DialogDescription>
        </DialogHeader>
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="proxy-import-text">Список</FieldLabel>
            <Textarea
              id="proxy-import-text"
              className="min-h-40 font-mono text-xs"
              spellCheck={false}
              value={text}
              onChange={(e) => {
                setText(e.target.value)
                preview.reset()
              }}
            />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field>
              <FieldLabel htmlFor="proxy-import-type">Тип для строк без схемы</FieldLabel>
              <ProxyTypeSelect
                id="proxy-import-type"
                value={defaultType}
                onChange={(t) => {
                  setDefaultType(t)
                  preview.reset()
                }}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="proxy-import-tag">Метка</FieldLabel>
              <Input id="proxy-import-tag" placeholder="необязательно" value={tag} onChange={(e) => setTag(e.target.value)} />
              <FieldDescription>Достанется всем прокси из этого списка.</FieldDescription>
            </Field>
          </div>
        </FieldGroup>
        {result && (
          <Alert variant={result.proxies.length ? 'default' : 'destructive'}>
            <AlertTitle className="flex flex-wrap items-center gap-2">
              Новых: {result.proxies.length}
              {result.errors.length > 0 && <Badge variant="destructive">ошибок: {result.errors.length}</Badge>}
              {result.duplicates.length > 0 && <Badge variant="outline">дублей: {result.duplicates.length}</Badge>}
            </AlertTitle>
            {problems.length > 0 && (
              <AlertDescription>
                <ul className="flex flex-col gap-1 font-mono text-xs">
                  {problems.slice(0, SHOWN_PROBLEMS).map((p) => (
                    <li key={`${p.line}-${p.kind}`}>
                      строка {p.line}: {p.kind}
                    </li>
                  ))}
                  {problems.length > SHOWN_PROBLEMS && <li>… и ещё {problems.length - SHOWN_PROBLEMS}</li>}
                </ul>
              </AlertDescription>
            )}
          </Alert>
        )}
        <DialogFooter>
          {result && result.proxies.length > 0 ? (
            <Button disabled={commit.isPending} onClick={() => commit.mutate()}>
              {commit.isPending && <Spinner data-icon="inline-start" />}
              Добавить {result.proxies.length}
            </Button>
          ) : (
            <Button disabled={!text.trim() || preview.isPending} onClick={() => preview.mutate()}>
              {preview.isPending && <Spinner data-icon="inline-start" />}
              Проверить список
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
