import type { QrState } from '@workspace/shared/accounts'
import { qrControlChannel, qrControlSchema } from '@workspace/shared/commands'
import { parseDuration } from '@workspace/shared/duration'
import type { WorkerDeps } from '../deps.ts'
import { createLoginKit } from '../login/common.ts'
import type { QrClientFactory } from './client.ts'

export interface QrStart {
  qrId: string
  proxyId: string | null
  adminId: string | null
}

export interface QrLoginOptions {
  /** overrides telegram.qrTimeout (tests) */
  timeoutMs?: number
  /** the new account is in the database: start it */
  onAccountCreated?: (accountId: string) => Promise<void> | void
}

/**
 * Runs one QR login: publishes the QR link and progress as `qr.update` events, takes the 2FA password from a
 * Redis channel (never stored in Redis), and on success saves the account with its session — and the cloud
 * password that let it through — for the account manager.
 */
export function createQrLogin(deps: WorkerDeps, factory: QrClientFactory, options: QrLoginOptions = {}) {
  const { settings, bus, logger } = deps
  const kit = createLoginKit(deps)

  const update = (qrId: string, state: QrState, extra: { url?: string; expiresAt?: string; hint?: string; accountId?: string; message?: string } = {}) =>
    bus.publish({ type: 'qr.update', qrId, state, ...extra })

  return {
    async run({ qrId, proxyId, adminId }: QrStart): Promise<void> {
      const apiId = settings.get('telegram.own.apiId')
      const apiHash = settings.get('telegram.own.apiHash')
      if (!apiId || !apiHash) {
        await update(qrId, 'failed', { message: 'Не задан свой api_id / api_hash (Настройки → Telegram)' })
        return
      }
      const abort = new AbortController()
      const timeoutMs = options.timeoutMs ?? parseDuration(settings.get('telegram.qrTimeout'))
      const timer = setTimeout(() => abort.abort(new Error('expired')), timeoutMs)
      let passwordWaiter: ((password: string) => void) | null = null
      const stopControl = await kit.subscribe(deps.redis, qrControlChannel(qrId), qrControlSchema, (message) => {
        if (message.type === 'cancel') abort.abort(new Error('cancelled'))
        if (message.type === 'password' && passwordWaiter) {
          passwordWaiter(message.password)
          passwordWaiter = null
        }
      })

      let client: ReturnType<QrClientFactory> | undefined
      try {
        const proxy = await kit.proxyEndpoint(proxyId)
        const device = kit.device()
        client = factory({ apiId, apiHash, device, proxy })
        const qrClient = client
        let hint: string | null | undefined
        // mtcute reports a wrong password and asks again at once: keep «неверный пароль» on screen until the next try
        let passwordWasWrong = false
        // the last password typed: signIn only returns once it was the right one
        let cloudPassword: string | null = null
        const profile = await qrClient.signIn({
          abortSignal: abort.signal,
          onUrlUpdated: (url, expires) => void update(qrId, 'waiting', { url, expiresAt: expires.toISOString() }),
          onQrScanned: () => void update(qrId, 'scanned'),
          password: async () => {
            if (hint === undefined) hint = await qrClient.passwordHint().catch(() => null)
            if (!passwordWasWrong) await update(qrId, 'password_needed', hint ? { hint } : {})
            const password = await new Promise<string>((resolve, reject) => {
              passwordWaiter = resolve
              abort.signal.addEventListener('abort', () => reject(abort.signal.reason), { once: true })
            })
            cloudPassword = password
            return password
          },
          invalidPasswordCallback: () => {
            passwordWasWrong = true
            void update(qrId, 'password_invalid', hint ? { hint } : {})
          },
        })

        const result = await kit.finish({ client: qrClient, profile, source: 'qr', proxyId, adminId, cloudPassword, device })
        client = undefined
        if ('duplicateOf' in result) {
          await update(qrId, 'failed', { message: 'Этот аккаунт уже есть в панели', accountId: result.duplicateOf })
          return
        }
        await update(qrId, 'done', { accountId: result.accountId })
        await options.onAccountCreated?.(result.accountId)
      } catch (err) {
        const reason = abort.signal.aborted ? String((abort.signal.reason as Error)?.message) : null
        if (reason === 'cancelled') await update(qrId, 'cancelled')
        else if (reason === 'expired') await update(qrId, 'expired')
        else {
          logger.warn({ err, qrId }, 'qr: login failed')
          await update(qrId, 'failed', { message: err instanceof Error ? err.message.slice(0, 300) : String(err) })
        }
      } finally {
        clearTimeout(timer)
        await stopControl()
        await client?.destroy().catch(() => {})
      }
    },
  }
}
