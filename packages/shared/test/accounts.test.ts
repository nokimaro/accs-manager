import { describe, expect, it } from 'vitest'
import {
  accountSourceLabels,
  accountTitle,
  cloudPasswordEmailInput,
  confirmImportInput,
  phoneCodeInput,
  setCloudPasswordInput,
  startPhoneLoginInput,
} from '../src/accounts.ts'
import { loginControlSchema, workerCommandSchema } from '../src/commands.ts'
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

describe('phone login input', () => {
  it('normalizes the phone number to digits and refuses what cannot be one', () => {
    expect(startPhoneLoginInput.parse({ phone: '+7 (700) 123-45-67', proxyId: null }).phone).toBe('77001234567')
    expect(startPhoneLoginInput.safeParse({ phone: '12345', proxyId: null }).success).toBe(false)
    expect(startPhoneLoginInput.safeParse({ phone: 'my phone', proxyId: null }).success).toBe(false)
  })

  it('takes the code with spaces or dashes and nothing but digits', () => {
    expect(phoneCodeInput.parse({ code: ' 12 345 ' }).code).toBe('12345')
    expect(phoneCodeInput.parse({ code: '12-345' }).code).toBe('12345')
    expect(phoneCodeInput.safeParse({ code: 'abcde' }).success).toBe(false)
  })

  it('carries code, password, resend and cancel over the login channel', () => {
    expect(loginControlSchema.parse({ type: 'code', code: '12345' })).toEqual({ type: 'code', code: '12345' })
    expect(loginControlSchema.safeParse({ type: 'password' }).success).toBe(false)
    expect(loginControlSchema.parse({ type: 'resend' })).toEqual({ type: 'resend' })
  })

  it('reports progress as phone.update events', () => {
    const event = { type: 'phone.update', loginId: 'l', state: 'code_sent', deliveryType: 'app', codeLength: 5, nextType: 'sms', retryAfterSec: 60 }
    expect(appEventSchema.parse(event)).toMatchObject({ state: 'code_sent', codeLength: 5 })
    expect(appEventSchema.safeParse({ ...event, state: 'nope' }).success).toBe(false)
  })

  it('names the new source', () => {
    expect(accountSourceLabels).toEqual({ tdata: 'tdata', qr: 'QR', phone: 'по номеру' })
  })
})

describe('cloud password input', () => {
  it('needs a new password; current password, hint and email are optional; the email must be one', () => {
    expect(setCloudPasswordInput.safeParse({ newPassword: '' }).success).toBe(false)
    expect(setCloudPasswordInput.parse({ newPassword: 'p4ss', hint: ' кот ' })).toEqual({ newPassword: 'p4ss', hint: 'кот' })
    expect(setCloudPasswordInput.safeParse({ newPassword: 'p4ss', email: 'not-an-email' }).success).toBe(false)
    expect(setCloudPasswordInput.parse({ currentPassword: 'old', newPassword: 'new', email: 'me@example.com' })).toMatchObject({ email: 'me@example.com' })
  })

  it('confirms, resends or cancels the recovery email', () => {
    expect(cloudPasswordEmailInput.parse({ action: 'confirm', code: '123 456' })).toEqual({ action: 'confirm', code: '123456' })
    expect(cloudPasswordEmailInput.safeParse({ action: 'confirm' }).success).toBe(false)
    expect(cloudPasswordEmailInput.parse({ action: 'cancel' })).toEqual({ action: 'cancel' })
  })

  it('sends secrets to the worker only as ciphertext fields', () => {
    const set = workerCommandSchema.parse({ type: 'account.password.set', accountId: 'a', currentPasswordEnc: null, newPasswordEnc: 'v1:x', hint: null, email: null })
    expect(Object.keys(set).filter((k) => /password|code/i.test(k)).every((k) => k.endsWith('Enc'))).toBe(true)
    expect(workerCommandSchema.safeParse({ type: 'account.password.verify', accountId: 'a', password: 'plain' }).success).toBe(false)
  })
})
