import { tl } from '@mtcute/core'
import type { PhoneLoginState } from '@workspace/shared/accounts'
import { loginControlChannel, loginControlSchema, type LoginControl } from '@workspace/shared/commands'
import { parseDuration } from '@workspace/shared/duration'
import type { WorkerDeps } from '../deps.ts'
import type { SessionProfile } from '../telegram/session.ts'
import { createLoginKit, LoginFailure } from './common.ts'
import type { PhoneClient, PhoneClientFactory, SentCodeInfo } from './phone-client.ts'

export interface PhoneStart {
  loginId: string
  /** digits only (the api normalizes it) */
  phone: string
  proxyId: string | null
  adminId: string | null
}

export interface PhoneLoginOptions {
  /** overrides telegram.qrTimeout (tests) */
  timeoutMs?: number
  /** the new account is in the database: start it */
  onAccountCreated?: (accountId: string) => Promise<void> | void
}

interface PhoneUpdate {
  deliveryType?: string
  codeLength?: number
  nextType?: string
  retryAfterSec?: number
  hint?: string
  accountId?: string
  message?: string
}

/** What Telegram (or mtcute) refused, in words for the admin. */
export function phoneLoginError(err: unknown): string {
  if (err instanceof LoginFailure) return err.message
  if (tl.RpcError.is(err)) {
    switch (err.text) {
      case 'PHONE_NUMBER_INVALID':
        return 'Неверный номер'
      case 'PHONE_NUMBER_BANNED':
        return 'Номер заблокирован Telegram'
      case 'PHONE_NUMBER_UNOCCUPIED':
        return 'На этот номер нет аккаунта Telegram — регистрация через панель не поддерживается'
      case 'FLOOD_WAIT_%d':
        return `Слишком много попыток — подождите ${Math.max(1, Math.ceil((err as tl.RpcError & { seconds?: number }).seconds! / 60))} мин`
      case 'PHONE_PASSWORD_FLOOD':
        return 'Слишком много попыток ввода пароля — подождите'
      default:
        return `Telegram отказал: ${err.code} ${err.text}`
    }
  }
  const message = err instanceof Error ? err.message : String(err)
  if (/signup is no longer supported/i.test(message)) return 'На этот номер нет аккаунта Telegram — регистрация через панель не поддерживается'
  if (/payment is required/i.test(message)) return 'Telegram требует платный вход для неофициальных приложений — войдите сначала в официальном'
  return message.slice(0, 300)
}

const isProfile = (v: SentCodeInfo | SessionProfile): v is SessionProfile => 'tgUserId' in v

/**
 * Runs one phone-number login: sends the code, takes the code, the cloud password, «send again» and cancel from
 * the login's Redis channel (never stored), publishes progress as `phone.update`, and on success saves the account
 * with its session and the cloud password that let it through.
 */
export function createPhoneLogin(deps: WorkerDeps, factory: PhoneClientFactory, options: PhoneLoginOptions = {}) {
  const { settings, bus, logger } = deps
  const kit = createLoginKit(deps)

  const update = (loginId: string, state: PhoneLoginState, extra: PhoneUpdate = {}) => bus.publish({ type: 'phone.update', loginId, state, ...extra })
  const codeInfo = (code: SentCodeInfo): PhoneUpdate => ({
    deliveryType: code.deliveryType,
    codeLength: code.codeLength,
    nextType: code.nextType,
    retryAfterSec: code.timeoutSec,
  })

  return {
    async run({ loginId, phone, proxyId, adminId }: PhoneStart): Promise<void> {
      const apiId = settings.get('telegram.own.apiId')
      const apiHash = settings.get('telegram.own.apiHash')
      if (!apiId || !apiHash) {
        await update(loginId, 'failed', { message: 'Не задан свой api_id / api_hash (Настройки → Telegram)' })
        return
      }
      const abort = new AbortController()
      const timeoutMs = options.timeoutMs ?? parseDuration(settings.get('telegram.qrTimeout'))
      const timer = setTimeout(() => abort.abort(new Error('expired')), timeoutMs)

      // messages from the admin, in order; cancel cuts through at once
      const inbox: LoginControl[] = []
      let wake: (() => void) | null = null
      const stopControl = await kit.subscribe(deps.redis, loginControlChannel(loginId), loginControlSchema, (message) => {
        if (message.type === 'cancel') abort.abort(new Error('cancelled'))
        else inbox.push(message)
        wake?.()
      })
      // the next message from the admin; a cancel or the timeout wins over anything still queued
      const next = async (): Promise<LoginControl> => {
        for (;;) {
          if (abort.signal.aborted) throw abort.signal.reason
          const message = inbox.shift()
          if (message) return message
          await new Promise<void>((resolve) => {
            const onAbort = () => resolve()
            abort.signal.addEventListener('abort', onAbort, { once: true })
            wake = () => {
              abort.signal.removeEventListener('abort', onAbort)
              resolve()
            }
          })
          wake = null
        }
      }
      const signal = abort.signal

      let client: PhoneClient | undefined
      let code: SentCodeInfo | undefined
      try {
        const proxy = await kit.proxyEndpoint(proxyId)
        const device = kit.device()
        client = factory({ apiId, apiHash, device, proxy })
        const phoneClient = client

        let profile: SessionProfile | undefined
        let cloudPassword: string | null = null
        // «send again» works after Telegram's countdown; an expired code needs a fresh sendCode, not a resend
        let resendAfter = 0
        let codeExpired = false
        const codeSent = async (sentCode: SentCodeInfo, extra: PhoneUpdate = {}) => {
          code = sentCode
          codeExpired = false
          resendAfter = Date.now() + sentCode.timeoutSec * 1000
          await update(loginId, 'code_sent', { ...codeInfo(sentCode), ...extra })
        }
        /** sendCode, the first time or after expiry: Telegram may also authorize at once */
        const sendFresh = async (): Promise<SessionProfile | undefined> => {
          const sentCode = await phoneClient.sendCode(phone, signal)
          if (isProfile(sentCode)) return sentCode
          if (sentCode.deliveryType === 'email_required') {
            throw new LoginFailure('Telegram требует привязать почту для входа — сделайте это в официальном приложении')
          }
          await codeSent(sentCode)
          return undefined
        }

        profile = await sendFresh()

        // the code
        let needsPassword = false
        while (!profile && !needsPassword) {
          const message = await next()
          if (message.type === 'resend') {
            if (codeExpired) {
              profile = await sendFresh()
              continue
            }
            // a click before the countdown (or with nothing to resend by) does not reach Telegram
            if (Date.now() < resendAfter || code!.nextType === 'none') continue
            try {
              await codeSent(await phoneClient.resendCode(phone, code!.phoneCodeHash, signal))
            } catch (err) {
              if (signal.aborted) throw err
              if (tl.RpcError.is(err, 'PHONE_CODE_EXPIRED')) {
                profile = await sendFresh()
                continue
              }
              // the code already sent may still be on its way or in the app: keep the login going
              await update(loginId, 'code_sent', {
                ...codeInfo(code!),
                retryAfterSec: 0,
                nextType: 'none',
                message: tl.RpcError.is(err, 'SEND_CODE_UNAVAILABLE') ? 'Telegram не отправил код повторно — введите код, который уже пришёл' : phoneLoginError(err),
              })
            }
          } else if (message.type === 'code') {
            try {
              profile = await phoneClient.signIn(phone, code!.phoneCodeHash, message.code, signal)
            } catch (err) {
              if (tl.RpcError.is(err, 'PHONE_CODE_INVALID')) await update(loginId, 'code_invalid', codeInfo(code!))
              else if (tl.RpcError.is(err, 'PHONE_CODE_EXPIRED')) {
                codeExpired = true
                await update(loginId, 'code_expired', codeInfo(code!))
              } else if (tl.RpcError.is(err, 'SESSION_PASSWORD_NEEDED')) needsPassword = true
              else throw err
            }
          }
        }

        // the cloud password
        if (!profile) {
          const hint = await phoneClient.passwordHint(signal).catch(() => null)
          await update(loginId, 'password_needed', hint ? { hint } : {})
          while (!profile) {
            const message = await next()
            if (message.type !== 'password') continue
            try {
              profile = await phoneClient.checkPassword(message.password, signal)
              cloudPassword = message.password
            } catch (err) {
              if (!tl.RpcError.is(err, 'PASSWORD_HASH_INVALID')) throw err
              await update(loginId, 'password_invalid', hint ? { hint } : {})
            }
          }
        }

        if (signal.aborted) {
          // Telegram authorized the session after the admin cancelled (or time ran out): no account, no stray device
          await phoneClient.logOut().catch(() => {})
          throw signal.reason
        }
        const result = await kit.finish({ client: phoneClient, profile, source: 'phone', proxyId, adminId, cloudPassword, device })
        client = undefined
        if ('duplicateOf' in result) {
          await update(loginId, 'failed', { message: 'Этот аккаунт уже есть в панели', accountId: result.duplicateOf })
          return
        }
        await update(loginId, 'done', { accountId: result.accountId })
        await options.onAccountCreated?.(result.accountId)
      } catch (err) {
        const reason = abort.signal.aborted ? String((abort.signal.reason as Error)?.message) : null
        if (reason === 'cancelled') {
          // let Telegram drop the pending code too
          if (client && code) await client.cancelCode(phone, code.phoneCodeHash).catch(() => {})
          await update(loginId, 'cancelled')
        } else if (reason === 'expired') await update(loginId, 'expired')
        else {
          if (!(err instanceof LoginFailure)) logger.warn({ err, loginId }, 'phone: login failed')
          await update(loginId, 'failed', { message: phoneLoginError(err) })
        }
      } finally {
        clearTimeout(timer)
        await stopControl()
        await client?.destroy().catch(() => {})
      }
    },
  }
}
