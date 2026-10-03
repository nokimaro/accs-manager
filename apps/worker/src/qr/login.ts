import { accounts, and, eq, isNull, proxies } from '@workspace/db'
import { writeAudit, type Redis } from '@workspace/server'
import type { QrState } from '@workspace/shared/accounts'
import { qrControlChannel, qrControlSchema, type QrControl } from '@workspace/shared/commands'
import { parseDuration } from '@workspace/shared/duration'
import type { WorkerDeps } from '../deps.ts'
import type { ProxyEndpoint } from '../proxies/checker.ts'
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
 * Redis channel (never stored), and on success saves the account with its session for the account manager.
 */
export function createQrLogin(deps: WorkerDeps, factory: QrClientFactory, options: QrLoginOptions = {}) {
  const { db, settings, bus, logger, cipher } = deps

  const update = (qrId: string, state: QrState, extra: { url?: string; expiresAt?: string; hint?: string; accountId?: string; message?: string } = {}) =>
    bus.publish({ type: 'qr.update', qrId, state, ...extra })

  async function proxyEndpoint(proxyId: string | null): Promise<ProxyEndpoint | null> {
    if (!proxyId) return null
    const [proxy] = await db
      .select()
      .from(proxies)
      .leftJoin(accounts, eq(accounts.proxyId, proxies.id))
      .where(and(eq(proxies.id, proxyId), isNull(proxies.disabledAt), isNull(accounts.id)))
    if (!proxy || !['ok', 'unchecked', 'failing'].includes(proxy.proxies.status)) throw new Error('Прокси недоступен или уже занят')
    const p = proxy.proxies
    return { type: p.type, host: p.host, port: p.port, username: p.username, password: p.passwordEnc ? cipher.decrypt(p.passwordEnc) : null }
  }

  /** A private subscriber connection per login: the password and cancel arrive on the login's own channel. */
  async function control(redis: Redis, qrId: string, onMessage: (message: QrControl) => void): Promise<() => Promise<void>> {
    const sub = redis.duplicate()
    await sub.subscribe(qrControlChannel(qrId))
    sub.on('message', (_channel: string, raw: string) => {
      try {
        onMessage(qrControlSchema.parse(JSON.parse(raw)))
      } catch {
        // malformed control message: ignore
      }
    })
    return async () => {
      await sub.quit().catch(() => {})
    }
  }

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
      const stopControl = await control(deps.redis, qrId, (message) => {
        if (message.type === 'cancel') abort.abort(new Error('cancelled'))
        if (message.type === 'password' && passwordWaiter) {
          passwordWaiter(message.password)
          passwordWaiter = null
        }
      })

      let client: ReturnType<QrClientFactory> | undefined
      try {
        const proxy = await proxyEndpoint(proxyId)
        const device = {
          deviceModel: settings.get('telegram.desktop.deviceModel'),
          systemVersion: settings.get('telegram.desktop.systemVersion'),
          appVersion: settings.get('telegram.desktop.appVersion'),
          langCode: settings.get('telegram.desktop.langCode'),
        }
        client = factory({ apiId, apiHash, device, proxy })
        const qrClient = client
        const profile = await qrClient.signIn({
          abortSignal: abort.signal,
          onUrlUpdated: (url, expires) => void update(qrId, 'waiting', { url, expiresAt: expires.toISOString() }),
          onQrScanned: () => void update(qrId, 'scanned'),
          password: async () => {
            const hint = await qrClient.passwordHint().catch(() => null)
            await update(qrId, 'password_needed', hint ? { hint } : {})
            return new Promise<string>((resolve, reject) => {
              passwordWaiter = resolve
              abort.signal.addEventListener('abort', () => reject(abort.signal.reason), { once: true })
            })
          },
          invalidPasswordCallback: () => void update(qrId, 'password_invalid'),
        })

        const [existing] = await db.select({ id: accounts.id }).from(accounts).where(eq(accounts.tgUserId, profile.tgUserId))
        if (existing) {
          // the account is already here: do not leave a second, unused session behind
          await qrClient.logOut().catch(() => {})
          await update(qrId, 'failed', { message: 'Этот аккаунт уже есть в панели', accountId: existing.id })
          return
        }
        const session = await qrClient.exportSession()
        const [created] = await db
          .insert(accounts)
          .values({
            tgUserId: profile.tgUserId,
            phone: profile.phone,
            username: profile.username,
            firstName: profile.firstName,
            lastName: profile.lastName,
            isPremium: profile.isPremium,
            dcId: profile.dcId,
            source: 'qr',
            clientProfile: 'own',
            device,
            connectionMode: proxyId ? 'proxy' : 'direct',
            proxyId,
            status: 'pending_check',
            sessionImportEnc: cipher.encrypt(session),
          })
          .returning({ id: accounts.id })
        await writeAudit(db, { actor: adminId ? { type: 'admin', adminId } : { type: 'system' }, action: 'account.qr.created', targetType: 'account', targetId: created!.id, result: 'ok' })
        await bus.publish({ type: 'accounts.changed', ids: [created!.id] })
        await update(qrId, 'done', { accountId: created!.id })
        await options.onAccountCreated?.(created!.id)
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
