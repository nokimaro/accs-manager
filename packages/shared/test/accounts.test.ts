import { describe, expect, it } from 'vitest'
import { accountTitle, confirmImportInput } from '../src/accounts.ts'
import { appEventSchema } from '../src/events.ts'

describe('accountTitle', () => {
  it('prefers label, then phone, then @username, then the Telegram id', () => {
    expect(accountTitle({ label: 'Основной', phone: '77001234567' })).toBe('Основной')
    expect(accountTitle({ phone: '77001234567', username: 'nox' })).toBe('+77001234567')
    expect(accountTitle({ username: 'nox', tgUserId: 1 })).toBe('@nox')
    expect(accountTitle({ tgUserId: 42 })).toBe('id 42')
  })
})

it('confirmImportInput requires a proxy id only for the "proxy" decision', () => {
  const id = '00000000-0000-4000-8000-000000000001'
  expect(confirmImportInput.safeParse({ items: [{ id, decision: 'proxy' }] }).success).toBe(false)
  expect(confirmImportInput.safeParse({ items: [{ id, decision: 'auto' }, { id, decision: 'skip' }] }).success).toBe(true)
})

it('app events carry new codes and QR progress', () => {
  expect(appEventSchema.parse({ type: 'code.new', id: 1, accountId: 'a', code: '575571', date: '2026-10-03T00:00:00.000Z' })).toMatchObject({ code: '575571' })
  expect(appEventSchema.safeParse({ type: 'qr.update', qrId: 'q', state: 'nope' }).success).toBe(false)
})
