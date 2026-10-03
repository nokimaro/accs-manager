import type { AccountSessionDto } from '@workspace/shared/accounts'

export interface SessionProfile {
  tgUserId: number
  phone: string | null
  username: string | null
  firstName: string | null
  lastName: string | null
  isPremium: boolean
  dcId: number | null
}

export interface FreezeInfo {
  since: Date | null
  until: Date | null
  appealUrl: string | null
}

export interface IncomingMessage {
  id: number
  date: Date
  text: string
  senderId: number
  /** raw reply markup (inline buttons), if any — the code may sit in a Copy Code button */
  markup: unknown
}

/** One live account client. The worker talks to Telegram only through this, so tests can fake it. */
export interface TelegramSession {
  /** connect (importing the tdata session the first time) and return who we are */
  start(): Promise<SessionProfile>
  profile(): Promise<SessionProfile>
  freezeInfo(): Promise<FreezeInfo>
  /** numeric id of a user by @username (cached by mtcute's peer storage) */
  resolveUserId(username: string): Promise<number>
  /** incoming messages from `userId` with id > `afterId`, oldest first */
  history(userId: number, afterId: number, limit: number): Promise<IncomingMessage[]>
  onMessage(listener: (message: IncomingMessage) => void): void
  /** failures outside a request we made (revoked key noticed by the updates loop, etc.) */
  onError(listener: (err: unknown) => void): void
  sessions(): Promise<AccountSessionDto[]>
  terminateSession(hash: string): Promise<void>
  logOut(): Promise<void>
  stop(): Promise<void>
}
