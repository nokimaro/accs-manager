import { accounts, and, eq, isNull, proxies, type AccountDevice } from '@workspace/db'
import { writeAudit, type Redis } from '@workspace/server'
import type { z } from 'zod'
import type { WorkerDeps } from '../deps.ts'
import type { ProxyEndpoint } from '../proxies/checker.ts'
import type { SessionProfile } from '../telegram/session.ts'

/** What finishing a login needs from the throwaway client (QR or phone). */
export interface LoginClient {
  exportSession(): Promise<string>
  logOut(): Promise<void>
  destroy(): Promise<void>
}

export interface FinishLogin {
  client: LoginClient
  profile: SessionProfile
  source: 'qr' | 'phone'
  proxyId: string | null
  adminId: string | null
  /** the cloud password that let the login through, if the account has one */
  cloudPassword: string | null
  device: AccountDevice
}

export type FinishResult = { accountId: string } | { duplicateOf: string }

/** A login that ends with a message for the admin as is (logged without details). */
export class LoginFailure extends Error {}

/** The Postgres error under a Drizzle one: its code and constraint, never the query parameters (they hold the phone). */
function dbCause(err: unknown): { code?: string; constraint?: string } {
  const cause = (err as { cause?: unknown })?.cause ?? err
  return typeof cause === 'object' && cause !== null ? (cause as { code?: string; constraint?: string }) : {}
}

function saveFailure(err: unknown): string {
  const { code, constraint } = dbCause(err)
  if (code === '23505' && constraint === 'accounts_tg_user_id_key') return 'Этот аккаунт уже есть в панели'
  if (code === '23503') return 'Прокси удалён — начните заново'
  return 'Не удалось сохранить аккаунт — начните заново'
}

/** The pieces QR and phone-number logins share: the proxy, the control channel, and saving the new account. */
export function createLoginKit(deps: WorkerDeps) {
  const { db, settings, cipher, bus, logger } = deps

  return {
    /** A usable proxy (the same rule as the api's isProxyUsable; other accounts may share it), or null for an explicit «direct». */
    async proxyEndpoint(proxyId: string | null): Promise<ProxyEndpoint | null> {
      if (!proxyId) return null
      const [p] = await db
        .select()
        .from(proxies)
        .where(and(eq(proxies.id, proxyId), isNull(proxies.disabledAt)))
      if (!p || !['ok', 'unchecked', 'failing'].includes(p.status)) throw new Error('Прокси недоступен')
      return { type: p.type, host: p.host, port: p.port, username: p.username, password: p.passwordEnc ? cipher.decrypt(p.passwordEnc) : null }
    },

    /** The device the login presents (and the account keeps): the Desktop profile from settings. */
    device(): AccountDevice {
      return {
        deviceModel: settings.get('telegram.desktop.deviceModel'),
        systemVersion: settings.get('telegram.desktop.systemVersion'),
        appVersion: settings.get('telegram.desktop.appVersion'),
        langCode: settings.get('telegram.desktop.langCode'),
      }
    },

    /** A private subscriber connection per login: secrets and commands arrive on the login's own channel. */
    async subscribe<T>(redis: Redis, channel: string, schema: z.ZodType<T>, onMessage: (message: T) => void): Promise<() => Promise<void>> {
      const sub = redis.duplicate()
      await sub.subscribe(channel)
      sub.on('message', (_channel: string, raw: string) => {
        try {
          onMessage(schema.parse(JSON.parse(raw)))
        } catch {
          // malformed control message: ignore
        }
      })
      return async () => {
        await sub.quit().catch(() => {})
      }
    },

    /**
     * Saves the new account with its session (and the cloud password, if one was typed), then destroys the login
     * client: one auth key — one client, the account manager starts its own. An account already in the panel is
     * refused and the new session logged out, so no unused device is left behind.
     */
    async finish(params: FinishLogin): Promise<FinishResult> {
      const { client, profile } = params
      const [existing] = await db.select({ id: accounts.id }).from(accounts).where(eq(accounts.tgUserId, profile.tgUserId))
      if (existing) {
        await client.logOut().catch(() => {})
        await client.destroy().catch(() => {})
        return { duplicateOf: existing.id }
      }
      let created: { id: string } | undefined
      try {
        const session = await client.exportSession()
        ;[created] = await db
          .insert(accounts)
          .values({
            tgUserId: profile.tgUserId,
            phone: profile.phone,
            username: profile.username,
            firstName: profile.firstName,
            lastName: profile.lastName,
            isPremium: profile.isPremium,
            dcId: profile.dcId,
            source: params.source,
            clientProfile: 'own',
            device: params.device,
            connectionMode: params.proxyId ? 'proxy' : 'direct',
            proxyId: params.proxyId,
            status: 'pending_check',
            sessionImportEnc: cipher.encrypt(session),
            cloudPasswordEnc: params.cloudPassword ? cipher.encrypt(params.cloudPassword) : null,
          })
          .returning({ id: accounts.id })
      } catch (err) {
        // the session is authorized but the panel cannot keep it: end it, or the owner keeps a device nobody controls
        const { code, constraint } = dbCause(err)
        logger.warn({ code, constraint, error: err instanceof Error ? err.name : typeof err }, 'login: saving the account failed')
        await client.logOut().catch(() => {})
        await client.destroy().catch(() => {})
        throw new LoginFailure(saveFailure(err))
      }
      await writeAudit(db, {
        actor: params.adminId ? { type: 'admin', adminId: params.adminId } : { type: 'system' },
        action: `account.${params.source}.created`,
        targetType: 'account',
        targetId: created!.id,
        result: 'ok',
      })
      await bus.publish({ type: 'accounts.changed', ids: [created!.id] })
      await client.destroy().catch(() => {})
      return { accountId: created!.id }
    },
  }
}

export type LoginKit = ReturnType<typeof createLoginKit>
