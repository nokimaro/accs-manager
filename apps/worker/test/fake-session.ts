import { tl } from '@mtcute/core'
import type { AccountSessionDto } from '@workspace/shared/accounts'
import { vi } from 'vitest'
import type { AccountRow, SessionFactory } from '../src/accounts/manager.ts'
import type { ProxyEndpoint } from '../src/proxies/checker.ts'
import type { FreezeInfo, IncomingMessage, PasswordState, SessionProfile, SetPasswordParams, TelegramSession } from '../src/telegram/session.ts'

export const rpcError = (code: number, text: string) => new tl.RpcError(code, text)

/** A scripted Telegram client: tests decide what start() does and push messages/errors in. */
export class FakeSession implements TelegramSession {
  account: AccountRow
  proxy: ProxyEndpoint | null
  importSession: string | null
  startResult: () => Promise<SessionProfile>
  freeze: FreezeInfo = { since: null, until: null, appealUrl: null }
  messageListeners: ((m: IncomingMessage) => void)[] = []
  errorListeners: ((err: unknown) => void)[] = []
  historyMessages: IncomingMessage[] = []
  stopped = false
  loggedOut = false
  resolved = new Map<string, number>([['VerificationCodes', 489000]])
  sessionList: AccountSessionDto[] = []
  terminated: string[] = []

  constructor(account: AccountRow, ctx: { proxy: ProxyEndpoint | null; importSession: string | null }, profile: Partial<SessionProfile> = {}) {
    this.account = account
    this.proxy = ctx.proxy
    this.importSession = ctx.importSession
    const full: SessionProfile = { tgUserId: account.tgUserId, phone: '77001234567', username: 'nox', firstName: 'Nox', lastName: null, isPremium: false, dcId: 2, ...profile }
    this.startResult = async () => full
  }

  /** like mtcute: destroying the client rejects a start() that is still connecting */
  private rejectStart?: (err: unknown) => void
  start = vi.fn(
    () =>
      new Promise<SessionProfile>((resolve, reject) => {
        this.rejectStart = reject
        this.startResult().then(resolve, reject)
      }),
  )
  profile = vi.fn(() => this.startResult())
  freezeInfo = vi.fn(async () => this.freeze)
  resolveUserId = vi.fn(async (username: string) => {
    const id = this.resolved.get(username)
    if (id === undefined) throw rpcError(400, 'USERNAME_NOT_OCCUPIED')
    return id
  })
  history = vi.fn(async (userId: number, afterId: number) => this.historyMessages.filter((m) => m.senderId === userId && m.id > afterId))
  onMessage(listener: (m: IncomingMessage) => void) {
    this.messageListeners.push(listener)
  }
  onError(listener: (err: unknown) => void) {
    this.errorListeners.push(listener)
  }
  sessions = vi.fn(async () => this.sessionList)
  terminateSession = vi.fn(async (hash: string) => {
    this.terminated.push(hash)
  })
  logOut = vi.fn(async () => {
    this.loggedOut = true
  })
  stop = vi.fn(async () => {
    this.stopped = true
    this.rejectStart?.(new Error('Session is reset'))
  })

  /**
   * The account's cloud password as Telegram keeps it; a new recovery email waits for code 424242. By default a
   * password set together with an email applies only once the email is confirmed (TDLib's documented behaviour);
   * `applyBeforeEmailConfirmed` models the other reading.
   */
  twoFa = {
    password: null as string | null,
    hint: null as string | null,
    email: null as string | null,
    pending: null as { email: string; code: string; password: string; hint: string | null } | null,
    pendingResetAt: null as Date | null,
    tooFreshSec: 0,
    floodSec: 0,
    applyBeforeEmailConfirmed: false,
  }
  passwordState = vi.fn(
    async (): Promise<PasswordState> => ({
      hasPassword: this.twoFa.password !== null,
      hint: this.twoFa.hint,
      hasRecovery: this.twoFa.email !== null,
      unconfirmedEmailPattern: this.twoFa.pending ? 'm***@example.com' : null,
      pendingResetAt: this.twoFa.pendingResetAt,
    }),
  )
  recoveryEmail = vi.fn(async (password: string) => {
    if (password !== this.twoFa.password) throw rpcError(400, 'PASSWORD_HASH_INVALID')
    return this.twoFa.email
  })
  setPassword = vi.fn(async (p: SetPasswordParams) => {
    if (this.twoFa.tooFreshSec) throw Object.assign(rpcError(400, 'SESSION_TOO_FRESH_%d'), { seconds: this.twoFa.tooFreshSec })
    if (this.twoFa.floodSec) throw Object.assign(rpcError(420, 'FLOOD_WAIT_%d'), { seconds: this.twoFa.floodSec })
    if (this.twoFa.password !== null && p.current !== this.twoFa.password) throw rpcError(400, 'PASSWORD_HASH_INVALID')
    if (p.email !== null && !p.email.includes('@')) throw rpcError(400, 'EMAIL_INVALID')
    if (p.email === null || this.twoFa.applyBeforeEmailConfirmed) {
      this.twoFa.password = p.next
      this.twoFa.hint = p.hint
    }
    if (p.email === null) return null
    this.twoFa.pending = { email: p.email, code: '424242', password: p.next, hint: p.hint }
    return { emailCodeLength: 6, emailPattern: 'm***@example.com' }
  })
  confirmPasswordEmail = vi.fn(async (code: string) => {
    if (!this.twoFa.pending || code !== this.twoFa.pending.code) throw rpcError(400, 'CODE_INVALID')
    this.twoFa.email = this.twoFa.pending.email
    this.twoFa.password = this.twoFa.pending.password
    this.twoFa.hint = this.twoFa.pending.hint
    this.twoFa.pending = null
  })
  resendPasswordEmail = vi.fn(async () => {})
  cancelPasswordEmail = vi.fn(async () => {
    this.twoFa.pending = null
  })

  emitMessage(m: IncomingMessage) {
    for (const l of this.messageListeners) l(m)
  }
  emitError(err: unknown) {
    for (const l of this.errorListeners) l(err)
  }
}

/** Factory recording every session it made; `configure` scripts each new one. */
export function fakeFactory(configure: (s: FakeSession) => void = () => {}) {
  const sessions: FakeSession[] = []
  const factory: SessionFactory = (account, ctx) => {
    const session = new FakeSession(account, ctx)
    configure(session)
    sessions.push(session)
    return session
  }
  return { factory, sessions, last: () => sessions.at(-1)! }
}
