import { expect, it } from 'vitest'
import { pageTitle } from './title'

it('puts the most specific part first and keeps the brand suffix', () => {
  expect(pageTitle()).toBe('Панель | 159.team')
  expect(pageTitle('Аудит')).toBe('Аудит | 159.team')
  expect(pageTitle('Уведомления', 'Настройки')).toBe('Уведомления — Настройки | 159.team')
})
