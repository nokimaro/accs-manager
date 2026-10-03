import { MemoryStorage, TelegramClient } from '@mtcute/node'
import type { AccountDevice } from '@workspace/db'
import { proxyTransport, type ProxyEndpoint } from '../proxies/checker.ts'
import { profileOf } from '../login/profile.ts'
import type { SessionProfile } from '../telegram/session.ts'

export interface QrSignInParams {
  onUrlUpdated: (url: string, expires: Date) => void
  onQrScanned: () => void
  /** called when the account has 2FA; resolves with the password the admin typed */
  password: () => Promise<string>
  invalidPasswordCallback: () => void
  abortSignal: AbortSignal
}

/** A throwaway client for one QR login; its session is exported and handed to the account manager. */
export interface QrClient {
  signIn(params: QrSignInParams): Promise<SessionProfile>
  passwordHint(): Promise<string | null>
  exportSession(): Promise<string>
  logOut(): Promise<void>
  destroy(): Promise<void>
}

export type QrClientFactory = (options: { apiId: number; apiHash: string; device: AccountDevice; proxy: ProxyEndpoint | null }) => QrClient

export const createMtcuteQrClient: QrClientFactory = (options) => {
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
  return {
    async signIn(params) {
      const user = await client.signInQr({
        onUrlUpdated: params.onUrlUpdated,
        onQrScanned: params.onQrScanned,
        password: params.password,
        invalidPasswordCallback: params.invalidPasswordCallback,
        abortSignal: params.abortSignal,
      })
      return profileOf(user)
    },
    async passwordHint() {
      const pwd = await client.call({ _: 'account.getPassword' })
      return pwd.hint ?? null
    },
    exportSession: () => client.exportSession(),
    async logOut() {
      await client.logOut()
    },
    destroy: () => client.destroy(),
  }
}
