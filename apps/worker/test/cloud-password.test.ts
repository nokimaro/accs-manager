import { accounts, eq } from '@workspace/db'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createAccountManager } from '../src/accounts/manager.ts'
import { createCloudPassword } from '../src/accounts/cloud-password.ts'
import { fakeFactory, type FakeSession } from './fake-session.ts'
import { setupWorker, type TestWorker } from './helpers.ts'

let w: TestWorker
beforeAll(async () => {
  w = await setupWorker()
})
afterAll(async () => {
  await w.close()
})
beforeEach(async () => {
  await w.t.db.delete(accounts)
})

const device = { deviceModel: 'Desktop', systemVersion: 'Windows 11 x64', appVersion: '7.2.9 x64', langCode: 'ru' }
let nextUser = 71000
const enc = (v: string) => w.deps.cipher.encrypt(v)

/** A connected account whose Telegram side is `script`, and the service under test. */
async function connected(script: (s: FakeSession) => void = () => {}, stored: string | null = null) {
  const [a] = await w.t.db
    .insert(accounts)
    .values({ tgUserId: nextUser++, source: 'tdata', clientProfile: 'desktop', device, connectionMode: 'direct', cloudPasswordEnc: stored ? enc(stored) : null })
    .returning()
  const fake = fakeFactory(script)
  const manager = createAccountManager(w.deps, fake.factory, {}, { jitterMs: 0 })
  await manager.sync(a!.id)
  const service = createCloudPassword(w.deps, manager.runningSession)
  const read = async (column: 'cloudPasswordEnc' | 'cloudPasswordPendingEnc') => {
    const [row] = await w.t.db.select({ v: accounts[column] }).from(accounts).where(eq(accounts.id, a!.id))
    return row!.v ? w.deps.cipher.decrypt(row!.v) : null
  }
  return { id: a!.id, session: fake.last(), manager, service, storedNow: () => read('cloudPasswordEnc'), pendingNow: () => read('cloudPasswordPendingEnc') }
}

describe('cloud password', () => {
  it('reports the state; the recovery email only when the panel knows the password', async () => {
    const unknown = await connected((s) => Object.assign(s.twoFa, { password: 'p1', hint: 'кот', email: 'me@example.com' }))
    expect(await unknown.service.info(unknown.id)).toEqual({
      info: { hasPassword: true, hint: 'кот', known: false, hasRecovery: true, recoveryEmail: null, unconfirmedEmailPattern: null, pendingResetAt: null },
    })
    const known = await connected((s) => Object.assign(s.twoFa, { password: 'p1', email: 'me@example.com', pendingResetAt: new Date('2026-10-10T00:00:00Z') }), 'p1')
    expect(await known.service.info(known.id)).toMatchObject({ info: { known: true, recoveryEmail: 'me@example.com', pendingResetAt: '2026-10-10T00:00:00.000Z' } })
    await unknown.manager.stopAll()
    await known.manager.stopAll()
    expect(await known.service.info(known.id)).toEqual({ error: 'not_running' })
  })

  it('forgets a stored password Telegram no longer accepts', async () => {
    const changed = await connected((s) => Object.assign(s.twoFa, { password: 'changed-elsewhere' }), 'old')
    expect(await changed.service.info(changed.id)).toMatchObject({ info: { hasPassword: true, known: false } })
    expect(await changed.storedNow()).toBeNull()
    const removed = await connected(() => {}, 'old')
    expect(await removed.service.info(removed.id)).toMatchObject({ info: { hasPassword: false, known: false } })
    expect(await removed.storedNow()).toBeNull()
    await changed.manager.stopAll()
    await removed.manager.stopAll()
  })

  it('remembers the current password only once Telegram confirms it', async () => {
    const a = await connected((s) => Object.assign(s.twoFa, { password: 'p1' }))
    expect(await a.service.verify(a.id, enc('wrong'))).toEqual({ error: 'wrong_password' })
    expect(await a.storedNow()).toBeNull()
    expect(await a.service.verify(a.id, enc('p1'))).toEqual({ ok: true })
    expect(await a.storedNow()).toBe('p1')
    await a.manager.stopAll()
  })

  it('sets a first password and changes it with the stored one, keeping the new one', async () => {
    const a = await connected()
    expect(await a.service.set(a.id, { currentPasswordEnc: null, newPasswordEnc: enc('first'), hint: 'кот', email: null })).toEqual({ ok: true })
    expect(a.session.twoFa).toMatchObject({ password: 'first', hint: 'кот' })
    expect(await a.storedNow()).toBe('first')
    expect(await a.service.set(a.id, { currentPasswordEnc: null, newPasswordEnc: enc('second'), hint: null, email: null })).toEqual({ ok: true })
    expect(a.session.setPassword).toHaveBeenLastCalledWith({ current: 'first', next: 'second', hint: null, email: null })
    expect(await a.storedNow()).toBe('second')
    await a.manager.stopAll()
  })

  it('needs the current password when the panel does not know it, and says which one was wrong', async () => {
    const a = await connected((s) => Object.assign(s.twoFa, { password: 'p1' }))
    expect(await a.service.set(a.id, { currentPasswordEnc: null, newPasswordEnc: enc('n'), hint: null, email: null })).toEqual({ error: 'password_unknown' })
    expect(await a.service.set(a.id, { currentPasswordEnc: enc('nope'), newPasswordEnc: enc('n'), hint: null, email: null })).toEqual({ error: 'wrong_password' })
    const stale = await connected((s) => Object.assign(s.twoFa, { password: 'p2' }), 'outdated')
    // the stored one is tried first; when it fails it is forgotten
    expect(await stale.service.set(stale.id, { currentPasswordEnc: null, newPasswordEnc: enc('n'), hint: null, email: null })).toEqual({ error: 'stale_password' })
    expect(await stale.storedNow()).toBeNull()
    await a.manager.stopAll()
    await stale.manager.stopAll()
  })

  it('reports how long Telegram makes a fresh session wait', async () => {
    const a = await connected((s) => (s.twoFa.tooFreshSec = 86_400))
    expect(await a.service.set(a.id, { currentPasswordEnc: null, newPasswordEnc: enc('n'), hint: null, email: null })).toEqual({ error: 'too_fresh', retryAfterSec: 86_400 })
    await a.manager.stopAll()
  })

  it('holds a password set with a recovery email as pending until Telegram applies it; confirms, resends or drops the email', async () => {
    const a = await connected()
    expect(await a.service.set(a.id, { currentPasswordEnc: null, newPasswordEnc: enc('p'), hint: null, email: 'not-an-email' })).toEqual({ error: 'email_invalid' })
    expect(await a.service.set(a.id, { currentPasswordEnc: null, newPasswordEnc: enc('p'), hint: null, email: 'me@example.com' })).toEqual({
      emailCodeNeeded: { pattern: 'm***@example.com', length: 6 },
    })
    expect([await a.storedNow(), await a.pendingNow()]).toEqual([null, 'p'])
    // reading the state while the email waits does not lose the pending password
    expect(await a.service.info(a.id)).toMatchObject({ info: { hasPassword: false, known: false, unconfirmedEmailPattern: 'm***@example.com' } })
    expect(await a.pendingNow()).toBe('p')
    expect(await a.service.email(a.id, 'confirm', enc('000000'))).toEqual({ error: 'code_invalid' })
    expect(await a.service.email(a.id, 'resend', null)).toEqual({ ok: true })
    expect(await a.service.email(a.id, 'confirm', enc('424242'))).toEqual({ ok: true })
    expect([await a.storedNow(), await a.pendingNow()]).toEqual(['p', null])
    expect(await a.service.info(a.id)).toMatchObject({ info: { hasPassword: true, known: true, hasRecovery: true, recoveryEmail: 'me@example.com' } })

    // skipping the email: Telegram keeps the old state, and so does the panel
    const b = await connected()
    await b.service.set(b.id, { currentPasswordEnc: null, newPasswordEnc: enc('p'), hint: null, email: 'me@example.com' })
    expect(await b.service.email(b.id, 'cancel', null)).toEqual({ ok: true })
    expect([await b.storedNow(), await b.pendingNow()]).toEqual([null, null])
    expect(await b.service.info(b.id)).toMatchObject({ info: { hasPassword: false, hasRecovery: false, unconfirmedEmailPattern: null } })
    await a.manager.stopAll()
    await b.manager.stopAll()
  })

  it('keeps the stored password while a change with a new email waits, then takes the new one', async () => {
    const a = await connected((s) => Object.assign(s.twoFa, { password: 'old' }), 'old')
    expect(await a.service.set(a.id, { currentPasswordEnc: null, newPasswordEnc: enc('new'), hint: null, email: 'me@example.com' })).toMatchObject({ emailCodeNeeded: {} })
    expect(await a.service.info(a.id)).toMatchObject({ info: { known: true } })
    expect([await a.storedNow(), await a.pendingNow()]).toEqual(['old', 'new'])
    expect(await a.service.email(a.id, 'confirm', enc('424242'))).toEqual({ ok: true })
    expect([await a.storedNow(), await a.pendingNow()]).toEqual(['new', null])
    await a.manager.stopAll()
  })

  it('also works when Telegram applies the password before the email is confirmed', async () => {
    const a = await connected((s) => (s.twoFa.applyBeforeEmailConfirmed = true))
    await a.service.set(a.id, { currentPasswordEnc: null, newPasswordEnc: enc('p'), hint: null, email: 'me@example.com' })
    // the state shows what Telegram applied: the pending password is the stored one now
    expect(await a.service.info(a.id)).toMatchObject({ info: { hasPassword: true, known: true } })
    expect([await a.storedNow(), await a.pendingNow()]).toEqual(['p', null])
    expect(await a.service.email(a.id, 'cancel', null)).toEqual({ ok: true })
    expect(await a.storedNow()).toBe('p')
    await a.manager.stopAll()
  })
})
