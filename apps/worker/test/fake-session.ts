import { tl } from '@mtcute/core'
import type { AccountSessionDto } from '@workspace/shared/accounts'
import { vi } from 'vitest'
import type { AccountRow, SessionFactory } from '../src/accounts/manager.ts'
import type { ProxyEndpoint } from '../src/proxies/checker.ts'
import type { FreezeInfo, IncomingMessage, SessionProfile, TelegramSession } from '../src/telegram/session.ts'

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

  start = vi.fn(() => this.startResult())
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
