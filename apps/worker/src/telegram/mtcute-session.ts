import { Long, tl } from '@mtcute/core'
import { tlJsonToJson } from '@mtcute/core/utils.js'
import { TelegramClient } from '@mtcute/node'
import type { AccountDevice } from '@workspace/db'
import type { AccountSessionDto } from '@workspace/shared/accounts'
import type { ProxyEndpoint } from '../proxies/checker.ts'
import { proxyTransport } from '../proxies/checker.ts'
import type { FreezeInfo, SessionProfile, TelegramSession } from './session.ts'
import type { ITelegramStorageProvider } from '@mtcute/core'

export interface MtcuteSessionOptions {
  apiId: number
  apiHash: string
  device: AccountDevice
  storage: ITelegramStorageProvider
  proxy: ProxyEndpoint | null
  /** string session from a tdata import, applied once before connecting */
  importSession: string | null
}

const iso = (seconds: number) => new Date(seconds * 1000).toISOString()

export function createMtcuteSession(options: MtcuteSessionOptions): TelegramSession {
  const client = new TelegramClient({
    apiId: options.apiId,
    apiHash: options.apiHash,
    storage: options.storage,
    ...(options.proxy ? { transport: proxyTransport(options.proxy) } : {}),
    initConnectionOptions: {
      deviceModel: options.device.deviceModel,
      systemVersion: options.device.systemVersion,
      appVersion: options.device.appVersion,
      langCode: options.device.langCode,
      systemLangCode: options.device.langCode,
      langPack: 'tdesktop',
    },
    logLevel: 1,
  })

  const toProfile = (me: Awaited<ReturnType<TelegramClient['getMe']>>): SessionProfile => {
    return {
      tgUserId: me.id,
      phone: me.phoneNumber ?? null,
      username: me.username ?? null,
      firstName: me.firstName || null,
      lastName: me.lastName ?? null,
      isPremium: me.isPremium,
      dcId: me.dcId ?? null,
    }
  }
  const profile = async (): Promise<SessionProfile> => toProfile(await client.getMe())

  return {
    async start() {
      if (options.importSession) await client.importSession(options.importSession, true)
      await client.connect()
      const me = await client.getMe()
      // what client.start() does after a successful getMe: remember «self» and start the updates loop —
      // without it no live messages arrive. start() itself is not used: on a dead session it falls back
      // to an interactive login.
      await client.notifyLoggedIn(me.raw)
      return toProfile(me)
    },
    profile,
    async freezeInfo(): Promise<FreezeInfo> {
      const res = await client.call({ _: 'help.getAppConfig', hash: 0 })
      if (res._ !== 'help.appConfig') return { since: null, until: null, appealUrl: null }
      const config = tlJsonToJson(res.config) as Record<string, unknown>
      const since = Number(config.freeze_since_date ?? 0)
      const until = Number(config.freeze_until_date ?? 0)
      return {
        since: since ? new Date(since * 1000) : null,
        until: until ? new Date(until * 1000) : null,
        appealUrl: typeof config.freeze_appeal_url === 'string' ? config.freeze_appeal_url : null,
      }
    },
    async resolveUserId(username) {
      const peer = await client.resolveUser(username)
      if (peer._ === 'inputUser') return peer.userId
      throw new Error(`@${username} is not a user`)
    },
    async history(userId, afterId, limit) {
      const page = await client.getHistory(userId, { minId: afterId, limit })
      return page
        .filter((m) => !m.isOutgoing && m.id > afterId)
        .map((m) => ({ id: m.id, date: m.date, text: m.text, senderId: m.sender.id, markup: (m.raw as { replyMarkup?: unknown }).replyMarkup ?? null }))
        .sort((a, b) => a.id - b.id)
    },
    onMessage(listener) {
      client.onNewMessage.add((m) => {
        if (m.isOutgoing) return
        listener({ id: m.id, date: m.date, text: m.text, senderId: m.sender.id, markup: (m.raw as { replyMarkup?: unknown }).replyMarkup ?? null })
      })
    },
    onError(listener) {
      client.onError.add((err) => listener(err))
    },
    async sessions(): Promise<AccountSessionDto[]> {
      const res = await client.call({ _: 'account.getAuthorizations' })
      return res.authorizations.map((a: tl.RawAuthorization) => ({
        hash: a.hash.toString(),
        current: Boolean(a.current),
        official: Boolean(a.officialApp),
        appName: a.appName,
        appVersion: a.appVersion,
        deviceModel: a.deviceModel,
        platform: a.platform,
        systemVersion: a.systemVersion,
        ip: a.ip,
        country: a.country,
        region: a.region,
        createdAt: iso(a.dateCreated),
        activeAt: iso(a.dateActive),
      }))
    },
    async terminateSession(hash) {
      await client.call({ _: 'account.resetAuthorization', hash: Long.fromString(hash) })
    },
    async passwordState() {
      const pwd = await client.call({ _: 'account.getPassword' })
      return {
        hasPassword: Boolean(pwd.hasPassword),
        hint: pwd.hint ?? null,
        hasRecovery: Boolean(pwd.hasRecovery),
        unconfirmedEmailPattern: pwd.emailUnconfirmedPattern ?? null,
        pendingResetAt: pwd.pendingResetDate ? new Date(pwd.pendingResetDate * 1000) : null,
      }
    },
    async recoveryEmail(password) {
      const pwd = await client.call({ _: 'account.getPassword' })
      const settings = await client.call({ _: 'account.getPasswordSettings', password: await client.computeSrpParams(pwd, password) })
      return settings.email ?? null
    },
    async setPassword({ current, next, hint, email }) {
      const pwd = await client.call({ _: 'account.getPassword' })
      const algo = pwd.newAlgo
      try {
        await client.call({
          _: 'account.updatePasswordSettings',
          password: current === null ? { _: 'inputCheckPasswordEmpty' } : await client.computeSrpParams(pwd, current),
          newSettings: {
            _: 'account.passwordInputSettings',
            newAlgo: algo,
            newPasswordHash: await client.computeNewPasswordHash(algo, next),
            hint: hint ?? '',
            ...(email !== null ? { email } : {}),
          },
        })
        return null
      } catch (err) {
        // the recovery email waits for its code (EMAIL_UNCONFIRMED_<code length>); whether the new password is in force
        // already or only after the confirmation is Telegram's call — the caller checks which one works
        if (!tl.RpcError.is(err, 'EMAIL_UNCONFIRMED_%d')) throw err
        const length = /EMAIL_UNCONFIRMED_(\d+)/.exec(err.message)?.[1]
        const after = await client.call({ _: 'account.getPassword' })
        return { emailCodeLength: length ? Number(length) : null, emailPattern: after.emailUnconfirmedPattern ?? null }
      }
    },
    async confirmPasswordEmail(code) {
      await client.verifyPasswordEmail(code)
    },
    async resendPasswordEmail() {
      await client.resendPasswordEmail()
    },
    async cancelPasswordEmail() {
      await client.cancelPasswordEmail()
    },
    async logOut() {
      await client.logOut()
    },
    async stop() {
      await client.destroy()
    },
  }
}
