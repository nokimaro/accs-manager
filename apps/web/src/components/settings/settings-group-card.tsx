import * as React from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { SettingsResponse } from '@workspace/shared/api'
import { settingsDef, type SettingGroup, type SettingKey } from '@workspace/shared/settings'
import { Alert, AlertDescription } from '@workspace/ui/components/alert'
import { Button } from '@workspace/ui/components/button'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@workspace/ui/components/card'
import { FieldGroup, FieldSeparator } from '@workspace/ui/components/field'
import { Spinner } from '@workspace/ui/components/spinner'
import { toast } from '@workspace/ui/components/toast'
import { TriangleAlertIcon } from 'lucide-react'
import { api, ApiError } from '@/lib/api'
import { settingsQueryOptions } from '@/lib/settings'
import { draftError, draftsToChanges, type Draft } from './draft'
import { SettingField } from './setting-field'

export function SettingsGroupCard({ group, data }: { group: SettingGroup; data: SettingsResponse }) {
  const queryClient = useQueryClient()
  const keys = React.useMemo(
    () => (Object.keys(settingsDef) as SettingKey[]).filter((k) => settingsDef[k].meta.group === group.id).sort((a, b) => settingsDef[a].meta.order - settingsDef[b].meta.order),
    [group.id],
  )
  const [drafts, setDrafts] = React.useState(() => new Map<SettingKey, Draft>())
  const [serverErrors, setServerErrors] = React.useState<Record<string, string>>({})

  const setDraft = (key: SettingKey, draft: Draft | undefined) => {
    setDrafts((prev) => {
      const next = new Map(prev)
      if (draft) next.set(key, draft)
      else next.delete(key)
      return next
    })
    setServerErrors((prev) => {
      const next = { ...prev }
      delete next[key]
      return next
    })
  }

  const errors = new Map(keys.map((k) => [k, serverErrors[k] ?? draftError(k, drafts.get(k))] as const))
  const invalid = [...errors.values()].some(Boolean)
  const missing = keys.filter((k) => settingsDef[k].meta.required && !data.items[k]?.isSet && drafts.get(k)?.kind !== 'set')

  const save = useMutation({
    mutationFn: () => api<SettingsResponse>('/settings', { method: 'PATCH', json: { changes: draftsToChanges(drafts) } }),
    onSuccess: (response) => {
      queryClient.setQueryData(settingsQueryOptions.queryKey, response)
      setDrafts(new Map())
      setServerErrors({})
      toast.add({ title: 'Сохранено', description: group.label })
    },
    onError: (err) => {
      if (err instanceof ApiError && err.status === 400) setServerErrors(err.fields)
      else toast.add({ title: 'Не удалось сохранить', description: err.message })
    },
  })

  return (
    <Card>
      <CardHeader>
        <CardTitle>{group.label}</CardTitle>
        <CardDescription>{group.description}</CardDescription>
      </CardHeader>
      <CardContent>
        <FieldGroup>
          {missing.length > 0 && (
            <Alert>
              <TriangleAlertIcon />
              <AlertDescription>Не заполнено: {missing.map((k) => settingsDef[k].meta.label).join(', ')}.</AlertDescription>
            </Alert>
          )}
          {keys.map((key, i) => {
            const draft = drafts.get(key)
            // an empty secret being typed is not an error yet (Save stays disabled until it is filled)
            const shownError = settingsDef[key].meta.type === 'secret' && draft?.kind === 'set' && draft.value === '' ? undefined : errors.get(key)
            return (
              <React.Fragment key={key}>
                {i > 0 && <FieldSeparator />}
                <SettingField settingKey={key} state={data.items[key]!} draft={draft} error={shownError} onDraft={(d) => setDraft(key, d)} />
              </React.Fragment>
            )
          })}
        </FieldGroup>
      </CardContent>
      <CardFooter className="gap-2">
        <Button disabled={drafts.size === 0 || invalid || save.isPending} onClick={() => save.mutate()}>
          {save.isPending && <Spinner data-icon="inline-start" />}
          Сохранить
        </Button>
        <Button
          variant="ghost"
          disabled={drafts.size === 0 || save.isPending}
          onClick={() => {
            setDrafts(new Map())
            setServerErrors({})
          }}
        >
          Отменить изменения
        </Button>
      </CardFooter>
    </Card>
  )
}
