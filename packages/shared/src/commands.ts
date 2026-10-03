import { z } from 'zod'
import type { AccountSessionDto, CloudPasswordInfoDto, EmailCodeNeeded } from './accounts.ts'

/** BullMQ queue the api uses to ask the worker to act on accounts and proxies. */
export const COMMANDS_QUEUE = 'worker-commands'

export const workerCommandSchema = z.discriminatedUnion('type', [
  /** (re)load the account from the database and run it if its status says so */
  z.object({ type: z.literal('account.sync'), accountId: z.string() }),
  /** disconnect and forget the client (pause, delete, proxy change); `logout` ends the Telegram session first */
  z.object({ type: z.literal('account.stop'), accountId: z.string(), logout: z.boolean().default(false) }),
  z.object({ type: z.literal('account.sessions'), accountId: z.string() }),
  z.object({ type: z.literal('account.terminateSession'), accountId: z.string(), hash: z.string().regex(/^-?\d+$/) }),
  z.object({ type: z.literal('proxy.check'), proxyId: z.string() }),
  z.object({ type: z.literal('proxy.sync') }),
  z.object({ type: z.literal('qr.start'), qrId: z.string(), proxyId: z.string().nullable(), adminId: z.string().nullable() }),
  z.object({ type: z.literal('phone.start'), loginId: z.string(), phone: z.string(), proxyId: z.string().nullable(), adminId: z.string().nullable() }),
  // cloud password: secrets travel encrypted with APP_ENCRYPTION_KEY (…Enc), never in clear in Redis
  z.object({ type: z.literal('account.password.info'), accountId: z.string() }),
  z.object({ type: z.literal('account.password.verify'), accountId: z.string(), passwordEnc: z.string() }),
  z.object({
    type: z.literal('account.password.set'),
    accountId: z.string(),
    currentPasswordEnc: z.string().nullable(),
    newPasswordEnc: z.string(),
    hint: z.string().nullable(),
    email: z.string().nullable(),
  }),
  z.object({ type: z.literal('account.password.email'), accountId: z.string(), action: z.enum(['confirm', 'resend', 'cancel']), codeEnc: z.string().nullable() }),
])

export type WorkerCommand = z.output<typeof workerCommandSchema>
export type WorkerCommandType = WorkerCommand['type']

/** Answers the api reads back (BullMQ job results). */
export interface AccountStopResult {
  /** a live client existed and was stopped */
  stopped: boolean
  loggedOut: boolean
}
export type AccountSessionsResult = { sessions: AccountSessionDto[] } | { error: 'not_running' }
export type TerminateSessionResult = { ok: true } | { error: 'not_running' }

/** Why a cloud password operation did not happen (the api turns these into messages). */
export type CloudPasswordError =
  | { error: 'not_running' }
  /** the password typed by the admin is wrong */
  | { error: 'wrong_password' }
  /** the stored password no longer fits — changed outside the panel; it was forgotten */
  | { error: 'stale_password' }
  /** the account has a password the panel does not know, and none was given */
  | { error: 'password_unknown' }
  | { error: 'too_fresh'; retryAfterSec: number }
  /** FLOOD_WAIT: too many attempts */
  | { error: 'flood'; retryAfterSec: number }
  | { error: 'email_invalid' }
  | { error: 'code_invalid' }
  | { error: 'code_expired' }
  | { error: 'other'; message: string }
export type CloudPasswordInfoResult = { info: CloudPasswordInfoDto } | CloudPasswordError
export type CloudPasswordVerifyResult = { ok: true } | CloudPasswordError
export type CloudPasswordSetResult = { ok: true } | { emailCodeNeeded: EmailCodeNeeded } | CloudPasswordError
export type CloudPasswordEmailResult = { ok: true } | CloudPasswordError

/** Redis pub/sub channel carrying the 2FA password (or a cancel) to a running QR login; never stored. */
export const qrControlChannel = (qrId: string) => `accs:qr:${qrId}`
export const qrControlSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('password'), password: z.string() }),
  z.object({ type: z.literal('cancel') }),
])
export type QrControl = z.output<typeof qrControlSchema>

/** Redis pub/sub channel of a running phone-number login: the code, the 2FA password, resend and cancel; never stored. */
export const loginControlChannel = (loginId: string) => `accs:login:${loginId}`
export const loginControlSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('code'), code: z.string() }),
  z.object({ type: z.literal('password'), password: z.string() }),
  z.object({ type: z.literal('resend') }),
  z.object({ type: z.literal('cancel') }),
])
export type LoginControl = z.output<typeof loginControlSchema>
