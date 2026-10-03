import { describe, expect, expectTypeOf, it } from 'vitest'
import {
  bool,
  decimal,
  duration,
  int,
  multiselect,
  secret,
  select,
  settingGroups,
  settingsDef,
  string,
  validateSettingChanges,
  type SettingKey,
  type SettingsValues,
} from '../src/settings/index.ts'

describe('setting helpers', () => {
  it('int enforces integer and bounds', () => {
    const d = int({ group: 'worker', label: 'x', default: 5, min: 1, max: 10 })
    expect(d.schema.safeParse(5).success).toBe(true)
    expect(d.schema.safeParse(0).success).toBe(false)
    expect(d.schema.safeParse(11).success).toBe(false)
    expect(d.schema.safeParse(1.5).success).toBe(false)
    expect(d.schema.safeParse('5').success).toBe(false)
    expect(d.meta).toMatchObject({ type: 'int', min: 1, max: 10, step: 1 })
  })

  it('decimal keeps string precision and checks scale/bounds', () => {
    const d = decimal({ group: 'worker', label: 'x', default: '0.25', min: 0, max: 1, scale: 2 })
    expect(d.schema.safeParse('0.5').success).toBe(true)
    expect(d.schema.safeParse('0.125').success).toBe(false)
    expect(d.schema.safeParse('1.01').success).toBe(false)
    expect(d.schema.safeParse(0.5).success).toBe(false)
  })

  it('duration validates format and bounds', () => {
    const d = duration({ group: 'proxy', label: 'x', default: '5m', min: '1m', max: '1h' })
    expect(d.schema.safeParse('30m').success).toBe(true)
    expect(d.schema.safeParse('30s').success).toBe(false)
    expect(d.schema.safeParse('2h').success).toBe(false)
    expect(d.schema.safeParse('5 minutes').success).toBe(false)
  })

  it('select and multiselect accept only listed options', () => {
    const options = [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }] as const
    const s = select({ group: 'proxy', label: 'x', options, default: 'a' })
    const m = multiselect({ group: 'proxy', label: 'x', options, default: ['a'] })
    expect(s.schema.safeParse('b').success).toBe(true)
    expect(s.schema.safeParse('c').success).toBe(false)
    expect(m.schema.safeParse(['a', 'b']).success).toBe(true)
    expect(m.schema.safeParse(['a', 'a']).success).toBe(false)
    expect(m.schema.safeParse(['c']).success).toBe(false)
    expectTypeOf(s.default).toEqualTypeOf<'a' | 'b'>()
  })

  it('string trims and rejects empty; bool is strict', () => {
    const s = string({ group: 'proxy', label: 'x', default: null })
    expect(s.schema.safeParse('  kz ').data).toBe('kz')
    expect(s.schema.safeParse('   ').success).toBe(false)
    const b = bool({ group: 'proxy', label: 'x', default: false })
    expect(b.schema.safeParse('true').success).toBe(false)
  })

  it('secret rejects empty string and defaults to null', () => {
    const d = secret({ group: 'notifications', label: 'x' })
    expect(d.default).toBeNull()
    expect(d.schema.safeParse('').error?.issues[0]?.message).toMatch(/Очистить/)
    expect(d.meta.type).toBe('secret')
  })

  it('throws at definition time when the default is invalid', () => {
    expect(() => int({ group: 'worker', label: 'bad', default: 0, min: 1 })).toThrow(/Default for "bad"/)
  })
})

describe('settings v1 definitions', () => {
  it('every setting belongs to a known group and has a valid default', () => {
    const groupIds = new Set<string>(settingGroups.map((g) => g.id))
    for (const [key, def] of Object.entries(settingsDef)) {
      expect(groupIds.has(def.meta.group), key).toBe(true)
      if (def.default !== null) expect(def.schema.safeParse(def.default).success, key).toBe(true)
    }
  })

  it('infers value types from definitions', () => {
    expectTypeOf<SettingsValues['worker.connectConcurrency']>().toEqualTypeOf<number>()
    expectTypeOf<SettingsValues['telegram.desktop.apiId']>().toEqualTypeOf<number | null>()
    expectTypeOf<SettingsValues['notify.botToken']>().toEqualTypeOf<string | null>()
    expectTypeOf<SettingsValues['notify.enabled']>().toEqualTypeOf<boolean>()
    expectTypeOf<SettingsValues['notify.events']>().toEqualTypeOf<
      ('code' | 'proxy_down' | 'unauthorized' | 'banned' | 'frozen' | 'proxy_expiring')[]
    >()
    expectTypeOf<'nope'>().not.toExtend<SettingKey>()
  })
})

describe('validateSettingChanges', () => {
  it('accepts valid changes and null resets', () => {
    const r = validateSettingChanges({ 'worker.connectConcurrency': 10, 'notify.botToken': null })
    expect(r.ok).toBe(true)
    if (r.ok) expect([...r.changes]).toEqual([['worker.connectConcurrency', 10], ['notify.botToken', null]])
  })

  it('is all-or-nothing and reports errors per key', () => {
    const r = validateSettingChanges({ 'worker.connectConcurrency': 10, 'proxy.checkInterval': '10s', 'no.such': 1 })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(Object.keys(r.errors).sort()).toEqual(['no.such', 'proxy.checkInterval'])
  })

  it('rejects an empty secret with a hint to use Clear', () => {
    const r = validateSettingChanges({ 'proxyStore.apiKey': '' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errors['proxyStore.apiKey']).toMatch(/Очистить/)
  })
})
