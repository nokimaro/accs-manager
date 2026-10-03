import { describe, expect, it } from 'vitest'
import { formatWait, formatDuration, isDuration, parseDuration } from '../src/duration.ts'

describe('duration', () => {
  it('parses all units', () => {
    expect(parseDuration('30s')).toBe(30_000)
    expect(parseDuration('5m')).toBe(300_000)
    expect(parseDuration('6h')).toBe(21_600_000)
    expect(parseDuration('7d')).toBe(604_800_000)
  })

  it('rejects malformed values', () => {
    for (const bad of ['', '5', 'm', '5 m', '1.5h', '-1m', '5M', '5min']) {
      expect(isDuration(bad)).toBe(false)
      expect(() => parseDuration(bad)).toThrow(/Invalid duration/)
    }
  })

  it('formats with the largest exact unit', () => {
    expect(formatDuration(300_000)).toBe('5m')
    expect(formatDuration(90_000)).toBe('90s')
    expect(formatDuration(86_400_000)).toBe('1d')
    expect(formatDuration(0)).toBe('0s')
  })
})

describe('formatWait', () => {
  it('says how long to wait in minutes, and in hours from one hour on', () => {
    expect(formatWait(30)).toBe('1 мин')
    expect(formatWait(600)).toBe('10 мин')
    expect(formatWait(3_600)).toBe('1 ч')
    expect(formatWait(86_400)).toBe('24 ч')
  })
})

