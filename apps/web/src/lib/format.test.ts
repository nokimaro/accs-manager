import { expect, it } from 'vitest'
import { formatRelative } from './format'

it('formats times relative to now in Russian', () => {
  const now = Date.parse('2026-10-03T12:00:00Z')
  expect(formatRelative('2026-10-03T11:55:00Z', now)).toBe('5 минут назад')
  expect(formatRelative('2026-10-03T12:00:00Z', now)).toBe('сейчас')
  expect(formatRelative('2026-10-06T12:00:00Z', now)).toBe('через 3 дня')
  expect(formatRelative(null, now)).toBe('—')
})
