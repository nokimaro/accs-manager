import * as React from 'react'
import type { SettingStateDto } from '@workspace/shared/api'
import { settingsDef, type SettingKey } from '@workspace/shared/settings'
import { Badge } from '@workspace/ui/components/badge'
import { Button } from '@workspace/ui/components/button'
import { Checkbox } from '@workspace/ui/components/checkbox'
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from '@workspace/ui/components/field'
import { Input } from '@workspace/ui/components/input'
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput, InputGroupText } from '@workspace/ui/components/input-group'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@workspace/ui/components/select'
import { Switch } from '@workspace/ui/components/switch'
import { Textarea } from '@workspace/ui/components/textarea'
import type { Draft } from './draft'

export interface SettingFieldProps {
  settingKey: SettingKey
  state: SettingStateDto
  draft: Draft | undefined
  error: string | undefined
  onDraft: (draft: Draft | undefined) => void
}

const EFFECT_HINT = { immediate: null, new_connections: 'к новым подключениям', restart: 'нужен перезапуск' } as const

/** The value shown in the control: draft → stored value → default. */
function shownValue(key: SettingKey, state: SettingStateDto, draft: Draft | undefined): unknown {
  if (draft?.kind === 'set') return draft.value
  if (draft?.kind === 'reset') return settingsDef[key].default
  return state.value
}

export function SettingField({ settingKey, state, draft, error, onDraft }: SettingFieldProps) {
  const def = settingsDef[settingKey]
  const meta = def.meta
  const id = `setting-${settingKey}`
  const value = shownValue(settingKey, state, draft)
  const nullable = def.default === null
  const overridden = draft ? draft.kind === 'set' : state.overridden
  const effect = EFFECT_HINT[meta.effect]

  const setText = (raw: string) => onDraft(raw === '' && nullable ? { kind: 'reset' } : { kind: 'set', value: raw })
  const setNumber = (raw: string) => onDraft(raw === '' && nullable ? { kind: 'reset' } : { kind: 'set', value: raw === '' ? Number.NaN : Number(raw) })

  let control: React.ReactNode
  switch (meta.type) {
    case 'string':
    case 'duration':
    case 'decimal':
      control = (
        <Input id={id} value={(value as string | null) ?? ''} onChange={(e) => setText(e.target.value)} aria-invalid={error ? true : undefined}
          inputMode={meta.type === 'decimal' ? 'decimal' : undefined} placeholder={meta.type === 'duration' ? 'например 5m' : undefined} />
      )
      break
    case 'text':
      control = <Textarea id={id} value={(value as string | null) ?? ''} onChange={(e) => setText(e.target.value)} aria-invalid={error ? true : undefined} />
      break
    case 'int':
      control = (
        <InputGroup>
          <InputGroupInput id={id} type="number" inputMode="numeric" step={1} value={value === null || Number.isNaN(value) ? '' : String(value)}
            min={meta.min as number | undefined} max={meta.max as number | undefined}
            onChange={(e) => setNumber(e.target.value)} aria-invalid={error ? true : undefined} />
          {meta.unit && (
            <InputGroupAddon align="inline-end">
              <InputGroupText>{meta.unit}</InputGroupText>
            </InputGroupAddon>
          )}
        </InputGroup>
      )
      break
    case 'bool':
      control = <Switch id={id} checked={value === true} onCheckedChange={(checked) => onDraft({ kind: 'set', value: checked })} />
      break
    case 'select': {
      const items = (meta.options ?? []).map((o) => ({ label: o.label, value: o.value }))
      control = (
        <Select items={items} value={value as string} onValueChange={(v) => onDraft({ kind: 'set', value: v })}>
          <SelectTrigger id={id} className="w-full max-w-sm">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {items.map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      )
      break
    }
    case 'multiselect': {
      const selected = new Set((value as string[] | null) ?? [])
      const toggle = (option: string, on: boolean) => {
        const next = (meta.options ?? []).map((o) => o.value).filter((v) => (v === option ? on : selected.has(v)))
        onDraft({ kind: 'set', value: next })
      }
      return (
        <FieldSet data-invalid={error ? true : undefined}>
          <div className="flex flex-wrap items-center gap-2">
            <FieldLegend variant="label">{meta.label}</FieldLegend>
            <StateBadges overridden={overridden} effect={effect} onReset={() => onDraft({ kind: 'reset' })} />
          </div>
          {meta.description && <FieldDescription>{meta.description}</FieldDescription>}
          {(meta.options ?? []).map((option) => (
            <Field key={option.value} orientation="horizontal">
              <Checkbox id={`${id}-${option.value}`} checked={selected.has(option.value)} onCheckedChange={(on) => toggle(option.value, on)} />
              <FieldLabel htmlFor={`${id}-${option.value}`}>{option.label}</FieldLabel>
            </Field>
          ))}
          {error && <FieldError>{error}</FieldError>}
        </FieldSet>
      )
    }
    case 'secret':
      control = <SecretControl id={id} isSet={state.isSet} draft={draft} onDraft={onDraft} invalid={Boolean(error)} />
      break
  }

  const hint = [meta.description, rangeHint(settingKey)].filter(Boolean).join(' ')
  return (
    <Field data-invalid={error ? true : undefined} orientation={meta.type === 'bool' ? 'horizontal' : 'vertical'}>
      <FieldContent>
        <div className="flex flex-wrap items-center gap-2">
          <FieldLabel htmlFor={id}>{meta.label}</FieldLabel>
          <StateBadges overridden={overridden} effect={effect} onReset={() => onDraft({ kind: 'reset' })} />
        </div>
        {hint && <FieldDescription>{hint}</FieldDescription>}
        {meta.type !== 'bool' && control}
        {error && <FieldError>{error}</FieldError>}
      </FieldContent>
      {meta.type === 'bool' && control}
    </Field>
  )
}

function boundsText(min: number | string | undefined, max: number | string | undefined): string {
  if (min !== undefined && max !== undefined) return `от ${min} до ${max}`
  if (min !== undefined) return `не меньше ${min}`
  if (max !== undefined) return `не больше ${max}`
  return ''
}

function rangeHint(key: SettingKey): string {
  const { type, min, max } = settingsDef[key].meta
  const bounds = boundsText(min, max)
  if (type === 'duration') return `Формат: 30s, 5m, 6h, 7d${bounds ? `; ${bounds}` : ''}.`
  if ((type === 'int' || type === 'decimal') && bounds) return `${bounds[0]!.toUpperCase()}${bounds.slice(1)}.`
  return ''
}

function StateBadges({ overridden, effect, onReset }: { overridden: boolean; effect: string | null; onReset: () => void }) {
  return (
    <>
      {effect && <Badge variant="outline">{effect}</Badge>}
      {overridden && (
        <>
          <Badge variant="secondary">изменено</Badge>
          <Button type="button" variant="link" size="xs" onClick={onReset}>
            Сбросить
          </Button>
        </>
      )}
    </>
  )
}

function SecretControl({ id, isSet, draft, onDraft, invalid }: { id: string; isSet: boolean; draft: Draft | undefined; onDraft: (d: Draft | undefined) => void; invalid: boolean }) {
  const editing = draft?.kind === 'set'
  if (editing) {
    return (
      <InputGroup>
        <InputGroupInput id={id} type="password" autoComplete="off" autoFocus value={draft.value as string}
          onChange={(e) => onDraft({ kind: 'set', value: e.target.value })} aria-invalid={invalid ? true : undefined} />
        <InputGroupAddon align="inline-end">
          <InputGroupButton onClick={() => onDraft(undefined)}>Отмена</InputGroupButton>
        </InputGroupAddon>
      </InputGroup>
    )
  }
  const status = draft?.kind === 'reset' ? 'Будет очищен' : isSet ? 'Задан' : 'Не задан'
  return (
    <InputGroup>
      <InputGroupInput id={id} disabled value="" placeholder={status} />
      <InputGroupAddon align="inline-end">
        <InputGroupButton onClick={() => onDraft({ kind: 'set', value: '' })}>{isSet ? 'Заменить' : 'Задать'}</InputGroupButton>
        {isSet && draft?.kind !== 'reset' && <InputGroupButton onClick={() => onDraft({ kind: 'reset' })}>Очистить</InputGroupButton>}
      </InputGroupAddon>
    </InputGroup>
  )
}
