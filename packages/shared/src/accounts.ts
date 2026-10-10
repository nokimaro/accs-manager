import { z } from 'zod'
import { PROXY_STATUSES, PROXY_TYPES } from './proxies.ts'

export const ACCOUNT_STATUSES = ['pending_check', 'active', 'paused', 'proxy_down', 'unauthorized', 'banned', 'frozen', 'error'] as const
export type AccountStatus = (typeof ACCOUNT_STATUSES)[number]

export const accountStatusLabels: Record<AccountStatus, string> = {
  pending_check: 'проверка',
  active: 'активен',
  paused: 'на паузе',
  proxy_down: 'прокси недоступен',
  unauthorized: 'сессия отозвана',
  banned: 'забанен',
  frozen: 'заморожен',
  error: 'ошибка',
}

/** Statuses in which the worker keeps (or tries to keep) a live client. */
export const RUNNING_STATUSES: readonly AccountStatus[] = ['pending_check', 'active', 'frozen', 'error']
/** Terminal statuses: the session is gone, only deletion makes sense. */
export const FINAL_STATUSES: readonly AccountStatus[] = ['unauthorized', 'banned']

export const ACCOUNT_SOURCES = ['tdata', 'qr', 'phone'] as const
export const accountSourceLabels: Record<(typeof ACCOUNT_SOURCES)[number], string> = { tdata: 'tdata', qr: 'QR', phone: 'по номеру' }
export const CLIENT_PROFILES = ['desktop', 'own'] as const
export const CONNECTION_MODES = ['proxy', 'direct'] as const

/** Codes are read only from this official service account (Telegram Gateway). */
export const CODE_SOURCE_USERNAME = 'VerificationCodes'

export const accountDeviceDto = z.object({ deviceModel: z.string(), systemVersion: z.string(), appVersion: z.string(), langCode: z.string() })

export const accountProxyRef = z.object({
  id: z.string(),
  type: z.enum(PROXY_TYPES),
  host: z.string(),
  port: z.number(),
  status: z.enum(PROXY_STATUSES),
  tgCountry: z.string().nullable(),
})

export const accountDto = z.object({
  id: z.string(),
  tgUserId: z.number(),
  phone: z.string().nullable(),
  username: z.string().nullable(),
  firstName: z.string().nullable(),
  lastName: z.string().nullable(),
  isPremium: z.boolean(),
  dcId: z.number().nullable(),
  label: z.string().nullable(),
  note: z.string().nullable(),
  source: z.enum(ACCOUNT_SOURCES),
  clientProfile: z.enum(CLIENT_PROFILES),
  device: accountDeviceDto,
  connectionMode: z.enum(CONNECTION_MODES),
  proxy: accountProxyRef.nullable(),
  status: z.enum(ACCOUNT_STATUSES),
  statusReason: z.string().nullable(),
  statusChangedAt: z.string(),
  lastOkAt: z.string().nullable(),
  frozenUntil: z.string().nullable(),
  /** the code of the account's latest @VerificationCodes message (null when it had none) and when it came */
  lastCode: z.string().nullable(),
  lastCodeAt: z.string().nullable(),
  createdAt: z.string(),
})
export type AccountDto = z.output<typeof accountDto>

export const updateAccountInput = z.object({
  label: z.string().trim().max(64).nullable().optional(),
  note: z.string().trim().max(2000).nullable().optional(),
})
export type UpdateAccountInput = z.output<typeof updateAccountInput>

/** `proxyId: null` = connect directly (only by an explicit decision). */
export const setAccountProxyInput = z.object({ proxyId: z.string().uuid().nullable() })
export type SetAccountProxyInput = z.output<typeof setAccountProxyInput>

export const deleteAccountQuery = z.object({ logout: z.stringbool().default(false) })

/** One active session of an account (account.getAuthorizations). */
export const accountSessionDto = z.object({
  hash: z.string(),
  current: z.boolean(),
  official: z.boolean(),
  appName: z.string(),
  appVersion: z.string(),
  deviceModel: z.string(),
  platform: z.string(),
  systemVersion: z.string(),
  ip: z.string(),
  country: z.string(),
  region: z.string(),
  createdAt: z.string(),
  activeAt: z.string(),
})
export type AccountSessionDto = z.output<typeof accountSessionDto>

// ---- test code (Telegram Gateway) ----

/** Gateway's delivery states: `delivered` and `read` are reported only while the account is online. */
export const GATEWAY_DELIVERY_STATUSES = ['sent', 'delivered', 'read', 'expired', 'revoked'] as const
export type GatewayDeliveryStatus = (typeof GATEWAY_DELIVERY_STATUSES)[number]

/** A test code sent through Telegram Gateway: the code itself arrives in @VerificationCodes like any other. */
export const testCodeDto = z.object({
  requestId: z.string(),
  delivery: z.enum(GATEWAY_DELIVERY_STATUSES).nullable(),
  /** what the request cost, in Gateway credits */
  cost: z.number().nullable(),
  remainingBalance: z.number().nullable(),
})
export type TestCodeDto = z.output<typeof testCodeDto>

// ---- tdata import ----

export const importItemDto = z.object({
  id: z.string(),
  pathInArchive: z.string(),
  accountIndex: z.number(),
  tgUserId: z.number(),
  dcId: z.number(),
  duplicateOf: z.object({ id: z.string(), label: z.string().nullable(), phone: z.string().nullable() }).nullable(),
  decision: z.enum(['pending', 'imported', 'skipped']),
  accountId: z.string().nullable(),
})
export type ImportItemDto = z.output<typeof importItemDto>

export const importBatchDto = z.object({
  id: z.string(),
  filename: z.string(),
  status: z.enum(['ready', 'confirmed']),
  createdAt: z.string(),
  expiresAt: z.string(),
  items: z.array(importItemDto),
})
export type ImportBatchDto = z.output<typeof importBatchDto>

export const confirmImportInput = z.object({
  items: z
    .array(
      z.discriminatedUnion('decision', [
        z.object({ id: z.string().uuid(), decision: z.literal('proxy'), proxyId: z.string().uuid() }),
        z.object({ id: z.string().uuid(), decision: z.literal('auto') }),
        z.object({ id: z.string().uuid(), decision: z.literal('direct') }),
        z.object({ id: z.string().uuid(), decision: z.literal('skip') }),
      ]),
    )
    .min(1),
})
export type ConfirmImportInput = z.output<typeof confirmImportInput>

export const confirmImportResult = z.object({ created: z.number(), skipped: z.number() })
export type ConfirmImportResult = z.output<typeof confirmImportResult>

// ---- codes ----

export const codeDto = z.object({
  id: z.number(),
  accountId: z.string(),
  account: z.object({ label: z.string().nullable(), phone: z.string().nullable(), username: z.string().nullable() }),
  tgMessageId: z.number(),
  date: z.string(),
  text: z.string(),
  code: z.string().nullable(),
  notifiedAt: z.string().nullable(),
})
export type CodeDto = z.output<typeof codeDto>

export const codesQuery = z.object({
  accountId: z.string().uuid().optional(),
  /** id of the oldest code already shown — returns older ones */
  before: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
})
export type CodesQuery = z.output<typeof codesQuery>

// ---- QR login ----

export const startQrInput = z.object({ proxyId: z.string().uuid().nullable() })
export type StartQrInput = z.output<typeof startQrInput>

export const qrPasswordInput = z.object({ password: z.string().min(1).max(256) })

export const QR_STATES = ['waiting', 'scanned', 'password_needed', 'password_invalid', 'done', 'failed', 'expired', 'cancelled'] as const
export type QrState = (typeof QR_STATES)[number]

// ---- login by phone number ----

/** E.164 without the plus: 7 to 15 digits. Spaces, dashes, brackets and a leading + are dropped. */
const phoneNumber = z
  .string()
  .transform((v) => v.replace(/[\s()+-]/g, ''))
  .pipe(z.string().regex(/^\d{7,15}$/, 'Номер — от 7 до 15 цифр, например +7 700 123 45 67'))

/** Login and email codes are digits; people paste them with spaces or dashes. */
const digitsCode = z
  .string()
  .transform((v) => v.replace(/[\s-]/g, ''))
  .pipe(z.string().regex(/^\d{3,10}$/, 'Код — только цифры'))

export const startPhoneLoginInput = z.object({ phone: phoneNumber, proxyId: z.string().uuid().nullable() })
export type StartPhoneLoginInput = z.output<typeof startPhoneLoginInput>
export const phoneCodeInput = z.object({ code: digitsCode })

export const PHONE_LOGIN_STATES = ['code_sent', 'code_invalid', 'code_expired', 'password_needed', 'password_invalid', 'done', 'failed', 'expired', 'cancelled'] as const
export type PhoneLoginState = (typeof PHONE_LOGIN_STATES)[number]

// ---- cloud password (2FA) of an account ----

const cloudPassword = z.string().min(1, 'Введите пароль').max(256)

/** What Telegram says about the account's cloud password, plus whether the panel knows it. */
export const cloudPasswordInfoDto = z.object({
  hasPassword: z.boolean(),
  hint: z.string().nullable(),
  /** the panel has the password stored */
  known: z.boolean(),
  hasRecovery: z.boolean(),
  /** the confirmed recovery email: Telegram tells it only to someone who knows the password */
  recoveryEmail: z.string().nullable(),
  /** a recovery email still waiting for its code, masked by Telegram */
  unconfirmedEmailPattern: z.string().nullable(),
  /** someone asked Telegram to reset the password: it goes at this time unless declined */
  pendingResetAt: z.string().nullable(),
})
export type CloudPasswordInfoDto = z.output<typeof cloudPasswordInfoDto>

export const verifyCloudPasswordInput = z.object({ password: cloudPassword })

export const setCloudPasswordInput = z.object({
  /** only when the panel does not know the current password */
  currentPassword: cloudPassword.optional(),
  newPassword: cloudPassword,
  hint: z.string().trim().max(128).optional(),
  /** a recovery email: Telegram mails a code to confirm it */
  email: z.string().trim().email('Неверная почта').max(256).optional(),
})
export type SetCloudPasswordInput = z.output<typeof setCloudPasswordInput>

export const cloudPasswordEmailInput = z.discriminatedUnion('action', [
  z.object({ action: z.literal('confirm'), code: digitsCode }),
  z.object({ action: z.literal('resend') }),
  z.object({ action: z.literal('cancel') }),
])
export type CloudPasswordEmailInput = z.output<typeof cloudPasswordEmailInput>

/** The recovery email is set but waits for the code Telegram mailed. */
export const emailCodeNeeded = z.object({ pattern: z.string().nullable(), length: z.number().nullable() })
export type EmailCodeNeeded = z.output<typeof emailCodeNeeded>

/** Shown under an account label when there is no label: phone, @username or Telegram id. */
/** «OLIMP-03 · +77001234567»: the title, and the phone too when a label stands in for it. */
export function accountFullTitle(a: { label?: string | null; phone?: string | null; username?: string | null; tgUserId?: number | null }): string {
  return a.label && a.phone ? `${a.label} · +${a.phone.replace(/^\+/, '')}` : accountTitle(a)
}

export function accountTitle(a: { label?: string | null; phone?: string | null; username?: string | null; tgUserId?: number | null }): string {
  if (a.label) return a.label
  if (a.phone) return `+${a.phone.replace(/^\+/, '')}`
  if (a.username) return `@${a.username}`
  return a.tgUserId ? `id ${a.tgUserId}` : 'аккаунт'
}
