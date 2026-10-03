import { MemoryStorage, TelegramClient } from '@mtcute/node'
import type { AccountDevice } from '@workspace/db'
import { proxyTransport, type ProxyEndpoint } from '../proxies/checker.ts'
import type { SessionProfile } from '../telegram/session.ts'
import type { LoginClient } from './common.ts'
import { profileOf } from './profile.ts'

/** Where Telegram sent the login code and what «send again» would do. */
export interface SentCodeInfo {
  phoneCodeHash: string
  /** app, sms, call, email, email_required, … (mtcute's SentCodeDeliveryType) */
  deliveryType: string
  codeLength: number
  /** how a resend would deliver it; 'none' — it cannot */
  nextType: string
  /** a resend is possible after this many seconds (0 — at once) */
  timeoutSec: number
}

/**
 * A throwaway client for one phone-number login; its session is exported and handed to the account manager.
 * `signal` ends a call that Telegram never answers (mtcute itself waits and reconnects forever).
 */
export interface PhoneClient extends LoginClient {
  /** the profile when Telegram authorizes at once (a future-auth token), otherwise where the code went */
  sendCode(phone: string, signal?: AbortSignal): Promise<SentCodeInfo | SessionProfile>
  resendCode(phone: string, phoneCodeHash: string, signal?: AbortSignal): Promise<SentCodeInfo>
  /** throws SESSION_PASSWORD_NEEDED when the account has a cloud password */
  signIn(phone: string, phoneCodeHash: string, code: string, signal?: AbortSignal): Promise<SessionProfile>
  checkPassword(password: string, signal?: AbortSignal): Promise<SessionProfile>
  cancelCode(phone: string, phoneCodeHash: string): Promise<void>
  passwordHint(signal?: AbortSignal): Promise<string | null>
}

export type PhoneClientFactory = (options: { apiId: number; apiHash: string; device: AccountDevice; proxy: ProxyEndpoint | null }) => PhoneClient

export const createMtcutePhoneClient: PhoneClientFactory = (options) => {
  const client = new TelegramClient({
    apiId: options.apiId,
    apiHash: options.apiHash,
    // in memory: the account row does not exist until the login succeeds
    storage: new MemoryStorage(),
    ...(options.proxy ? { transport: proxyTransport(options.proxy) } : {}),
    initConnectionOptions: {
      deviceModel: options.device.deviceModel,
      systemVersion: options.device.systemVersion,
      appVersion: options.device.appVersion,
      langCode: options.device.langCode,
      systemLangCode: options.device.langCode,
    },
    logLevel: 1,
  })
  const info = (code: { phoneCodeHash: string; type: string; length: number; nextType: string; timeout: number }): SentCodeInfo => ({
    phoneCodeHash: code.phoneCodeHash,
    deliveryType: code.type,
    codeLength: code.length,
    nextType: code.nextType,
    timeoutSec: code.timeout,
  })
  return {
    async sendCode(phone, abortSignal) {
      const res = await client.sendCode({ phone, abortSignal })
      return 'phoneCodeHash' in res ? info(res) : profileOf(res)
    },
    async resendCode(phone, phoneCodeHash, abortSignal) {
      return info(await client.resendCode({ phone, phoneCodeHash, abortSignal }))
    },
    async signIn(phone, phoneCodeHash, code, abortSignal) {
      return profileOf(await client.signIn({ phone, phoneCodeHash, phoneCode: code, abortSignal }))
    },
    async checkPassword(password, abortSignal) {
      return profileOf(await client.checkPassword({ password, abortSignal }))
    },
    async cancelCode(phone, phoneCodeHash) {
      await client.call({ _: 'auth.cancelCode', phoneNumber: phone, phoneCodeHash })
    },
    async passwordHint(abortSignal) {
      const pwd = await client.call({ _: 'account.getPassword' }, { abortSignal })
      return pwd.hint ?? null
    },
    exportSession: () => client.exportSession(),
    async logOut() {
      await client.logOut()
    },
    destroy: () => client.destroy(),
  }
}
