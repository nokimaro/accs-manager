import { describe, expect, it } from 'vitest'
import { durationInWords, pluralRu, rangeHint, settingsDef, unitSuffix, type SettingKey } from '../src/settings/index.ts'

describe('pluralRu', () => {
  const days = ['день', 'дня', 'дней'] as const
  it.each([
    [1, 'день'], [2, 'дня'], [4, 'дня'], [5, 'дней'], [11, 'дней'], [12, 'дней'], [21, 'день'], [22, 'дня'], [3650, 'дней'], [0, 'дней'],
  ])('%i → %s', (n, form) => {
    expect(pluralRu(n, days)).toBe(form)
  })
})

describe('durationInWords', () => {
  it('names a duration in the nominative case', () => {
    expect(durationInWords('5m')).toBe('5 минут')
    expect(durationInWords('1d')).toBe('1 день')
    expect(durationInWords('6h')).toBe('6 часов')
    expect(durationInWords('30s')).toBe('30 секунд')
    expect(durationInWords('2h')).toBe('2 часа')
  })

  it('uses the genitive case after «от»/«до»', () => {
    expect(durationInWords('1m', 'genitive')).toBe('1 минуты')
    expect(durationInWords('1d', 'genitive')).toBe('1 дня')
    expect(durationInWords('15m', 'genitive')).toBe('15 минут')
    expect(durationInWords('21h', 'genitive')).toBe('21 часа')
  })

  it('returns null for an invalid duration', () => {
    expect(durationInWords('5 min')).toBeNull()
  })
})

describe('unitSuffix', () => {
  it('declines the unit by the entered number', () => {
    const unit = settingsDef['retention.codeMessagesDays'].meta.unit!
    expect(unitSuffix(unit, 1)).toBe('день')
    expect(unitSuffix(unit, 3)).toBe('дня')
    expect(unitSuffix(unit, 30)).toBe('дней')
    expect(unitSuffix(unit, null)).toBe('дней')
  })
})

describe('rangeHint', () => {
  it('names the unit and the bounds of numeric settings', () => {
    expect(rangeHint('retention.codeMessagesDays')).toBe('В днях: от 1 до 3650.')
    expect(rangeHint('import.maxZipSizeMb')).toBe('В мегабайтах: от 1 до 1024.')
  })

  it('spells out duration bounds in words', () => {
    expect(rangeHint('proxy.checkInterval')).toBe('Длительность: 30s, 5m, 6h, 7d (с, мин, ч, дн.); от 1 минуты до 1 дня.')
  })

  it('stays silent for identifiers and text', () => {
    expect(rangeHint('telegram.desktop.apiId')).toBe('')
    expect(rangeHint('notify.chatId')).toBe('')
  })

  it('every numeric setting declares a unit, every setting explains itself', () => {
    for (const key of Object.keys(settingsDef) as SettingKey[]) {
      const meta = settingsDef[key].meta
      expect(meta.description, key).toBeTruthy()
      expect(meta.help, key).toBeTruthy()
      if (meta.type === 'int' && !key.endsWith('.apiId')) expect(meta.unit, key).toBeDefined()
    }
  })
})
