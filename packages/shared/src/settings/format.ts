import { isDuration, type DurationUnit } from '../duration.ts'
import { settingsDef, type SettingKey } from './definitions.ts'
import type { SettingUnit } from './types.ts'

const pluralRules = new Intl.PluralRules('ru')

/** Russian noun form for a count: 1 день, 2 дня, 5 дней (fractions take the 2–4 form). */
export function pluralRu(n: number, forms: readonly [one: string, few: string, many: string]): string {
  const rule = pluralRules.select(n)
  if (rule === 'one') return forms[0]
  if (rule === 'many') return forms[2]
  return forms[1]
}

/** Suffix shown inside a numeric input; an empty or invalid value takes the 5+ form. */
export function unitSuffix(unit: SettingUnit, value: number | null): string {
  return value === null || !Number.isFinite(value) ? unit.forms[2] : pluralRu(value, unit.forms)
}

// nominative: 1 минута / 2 минуты / 5 минут; genitive (после «от», «до»): 1 минуты / 5 минут
const DURATION_WORDS: Record<DurationUnit, { nominative: readonly [string, string, string]; genitive: readonly [string, string] }> = {
  s: { nominative: ['секунда', 'секунды', 'секунд'], genitive: ['секунды', 'секунд'] },
  m: { nominative: ['минута', 'минуты', 'минут'], genitive: ['минуты', 'минут'] },
  h: { nominative: ['час', 'часа', 'часов'], genitive: ['часа', 'часов'] },
  d: { nominative: ['день', 'дня', 'дней'], genitive: ['дня', 'дней'] },
}

/** '5m' → '5 минут'; with 'genitive' → '5 минут' / '1 минуты'. Null for an invalid duration. */
export function durationInWords(value: string, grammaticalCase: 'nominative' | 'genitive' = 'nominative'): string | null {
  if (!isDuration(value)) return null
  const n = Number(value.slice(0, -1))
  const words = DURATION_WORDS[value.slice(-1) as DurationUnit]
  const word = grammaticalCase === 'nominative' ? pluralRu(n, words.nominative) : pluralRules.select(n) === 'one' ? words.genitive[0] : words.genitive[1]
  return `${n} ${word}`
}

function bounds(min: string | undefined, max: string | undefined): string {
  if (min !== undefined && max !== undefined) return `от ${min} до ${max}`
  if (min !== undefined) return `не меньше ${min}`
  if (max !== undefined) return `не больше ${max}`
  return ''
}

/** Units and bounds shown under a control, e.g. «В днях: от 1 до 3650.» Empty when there is nothing to say. */
export function rangeHint(key: SettingKey): string {
  const { type, min, max, unit } = settingsDef[key].meta
  if (type === 'duration') {
    const word = (v: number | string | undefined) => (v === undefined ? undefined : (durationInWords(String(v), 'genitive') ?? String(v)))
    const range = bounds(word(min), word(max))
    return `Длительность: 30s, 5m, 6h, 7d (с, мин, ч, дн.)${range ? `; ${range}` : ''}.`
  }
  if ((type === 'int' || type === 'decimal') && unit) {
    const range = bounds(min === undefined ? undefined : String(min), max === undefined ? undefined : String(max))
    return range ? `${unit.hint}: ${range}.` : `${unit.hint}.`
  }
  return ''
}
