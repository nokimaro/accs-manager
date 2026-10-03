import { z } from 'zod'
import { isDuration, parseDuration } from '../duration.ts'
import type { SettingDef, SettingEffect, SettingGroupId, SettingMeta, SettingOption, SettingType, SettingUnit } from './types.ts'

interface CommonOpts {
  group: SettingGroupId
  label: string
  description?: string
  help?: string
  effect?: SettingEffect
  required?: boolean
}

let orderCounter = 0

function meta(type: SettingType, o: CommonOpts, extra: Partial<SettingMeta> = {}): SettingMeta {
  return {
    type,
    group: o.group,
    label: o.label,
    ...(o.description === undefined ? {} : { description: o.description }),
    ...(o.help === undefined ? {} : { help: o.help }),
    effect: o.effect ?? 'immediate',
    order: orderCounter++,
    required: o.required ?? false,
    ...extra,
  }
}

function make<T, D extends T | null>(schema: z.ZodType<T>, defaultValue: D, m: SettingMeta): SettingDef<T, D> {
  if (defaultValue !== null) {
    const check = schema.safeParse(defaultValue)
    if (!check.success) throw new Error(`Default for "${m.label}" is invalid: ${z.prettifyError(check.error)}`)
  }
  return { schema, default: defaultValue, meta: m }
}

const NON_EMPTY = 'Не может быть пустым'

export function string<const D extends string | null>(
  o: CommonOpts & { default: D; pattern?: RegExp; patternMessage?: string; maxLength?: number },
): SettingDef<string, D> {
  let schema = z.string().trim().min(1, NON_EMPTY).max(o.maxLength ?? 500)
  if (o.pattern) schema = schema.regex(o.pattern, o.patternMessage ?? 'Неверный формат')
  return make(schema, o.default, meta('string', o))
}

export function text<const D extends string | null>(
  o: CommonOpts & { default: D; maxLength?: number },
): SettingDef<string, D> {
  const schema = z.string().trim().min(1, NON_EMPTY).max(o.maxLength ?? 10_000)
  return make(schema, o.default, meta('text', o))
}

export function int<const D extends number | null>(
  o: CommonOpts & { default: D; min?: number; max?: number; unit?: SettingUnit },
): SettingDef<number, D> {
  let schema = z.number({ error: 'Нужно целое число' }).int('Нужно целое число')
  if (o.min !== undefined) schema = schema.min(o.min, `Не меньше ${o.min}`)
  if (o.max !== undefined) schema = schema.max(o.max, `Не больше ${o.max}`)
  return make(
    schema,
    o.default,
    meta('int', o, { step: 1, ...pick(o, ['min', 'max', 'unit']) }),
  )
}

/** Decimal values travel as strings to avoid float rounding (e.g. "0.25"). */
export function decimal<const D extends string | null>(
  o: CommonOpts & { default: D; min?: number; max?: number; scale?: number; unit?: SettingUnit },
): SettingDef<string, D> {
  const scale = o.scale ?? 2
  const re = new RegExp(`^-?\\d+(\\.\\d{1,${scale}})?$`)
  const schema = z
    .string()
    .regex(re, `Число с не более чем ${scale} знаками после точки`)
    .refine((v) => o.min === undefined || Number(v) >= o.min, `Не меньше ${o.min}`)
    .refine((v) => o.max === undefined || Number(v) <= o.max, `Не больше ${o.max}`)
  return make(
    schema,
    o.default,
    meta('decimal', o, { step: 10 ** -scale, ...pick(o, ['min', 'max', 'unit']) }),
  )
}

export function bool(o: CommonOpts & { default: boolean }): SettingDef<boolean, boolean> {
  return make(z.boolean({ error: 'Нужно да/нет' }), o.default, meta('bool', o))
}

export function select<const V extends string>(
  o: CommonOpts & { options: readonly SettingOption<V>[]; default: NoInfer<V> },
): SettingDef<V, V> {
  const values = o.options.map((x) => x.value) as [V, ...V[]]
  return make(z.enum(values, { error: 'Выберите значение из списка' }) as unknown as z.ZodType<V>, o.default, meta('select', o, { options: o.options }))
}

export function multiselect<const V extends string>(
  o: CommonOpts & { options: readonly SettingOption<V>[]; default: NoInfer<V>[] },
): SettingDef<V[], V[]> {
  const values = o.options.map((x) => x.value) as [V, ...V[]]
  const schema = z
    .array(z.enum(values, { error: 'Недопустимое значение' }))
    .refine((arr) => new Set(arr).size === arr.length, 'Значения не должны повторяться')
  return make(schema as unknown as z.ZodType<V[]>, o.default, meta('multiselect', o, { options: o.options }))
}

/** Durations are strings like "30s", "5m", "6h", "7d"; consumers use parseDuration(). */
export function duration<const D extends string | null>(
  o: CommonOpts & { default: D; min?: string; max?: string },
): SettingDef<string, D> {
  const minMs = o.min === undefined ? undefined : parseDuration(o.min)
  const maxMs = o.max === undefined ? undefined : parseDuration(o.max)
  const schema = z
    .string()
    .refine(isDuration, 'Формат: число и единица — 30s, 5m, 6h, 7d')
    .refine((v) => !isDuration(v) || minMs === undefined || parseDuration(v) >= minMs, `Не меньше ${o.min}`)
    .refine((v) => !isDuration(v) || maxMs === undefined || parseDuration(v) <= maxMs, `Не больше ${o.max}`)
  return make(schema, o.default, meta('duration', o, pick(o, ['min', 'max'])))
}

/** Stored encrypted; the API never returns the value, only whether it is set. */
export function secret(o: CommonOpts): SettingDef<string, null> {
  const schema = z.string().min(1, 'Пустое значение — используйте «Очистить»').max(4096)
  return make(schema, null, meta('secret', o))
}

function pick<T extends object, K extends keyof T>(obj: T, keys: K[]): Partial<Pick<T, K>> {
  const out: Partial<Pick<T, K>> = {}
  for (const k of keys) if (obj[k] !== undefined) out[k] = obj[k]
  return out
}
