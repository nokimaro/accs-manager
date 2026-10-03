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

/** What Telegram tells anyone about the account's cloud password (account.getPassword). */
export interface PasswordState {
  hasPassword: boolean
  hint: string | null
  hasRecovery: boolean
  unconfirmedEmailPattern: string | null
  pendingResetAt: Date | null
}

export interface SetPasswordParams {
  /** null when the account has no password yet */
  current: string | null
  next: string
  hint: string | null
  /** a new recovery email; null keeps the current one */
  email: string | null
}

/** The recovery email waits for the code Telegram mailed. */
export interface EmailCodeInfo {
  emailCodeLength: number | null
  emailPattern: string | null
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
  passwordState(): Promise<PasswordState>
  /** the confirmed recovery email; throws PASSWORD_HASH_INVALID when `password` is wrong (so it also checks it) */
  recoveryEmail(password: string): Promise<string | null>
  /** sets or changes the cloud password; tells when the new recovery email waits for its code */
  setPassword(params: SetPasswordParams): Promise<EmailCodeInfo | null>
  confirmPasswordEmail(code: string): Promise<void>
  resendPasswordEmail(): Promise<void>
  cancelPasswordEmail(): Promise<void>
  logOut(): Promise<void>
  stop(): Promise<void>
}
