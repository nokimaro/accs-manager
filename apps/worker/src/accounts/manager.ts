import { accounts, and, eq, inArray, notInArray, proxies } from '@workspace/db'
import { writeAudit } from '@workspace/server'
import { RUNNING_STATUSES, type AccountSessionDto, type AccountStatus } from '@workspace/shared/accounts'
import type { WorkerDeps } from '../deps.ts'
import type { ProxyEndpoint } from '../proxies/checker.ts'
import { classifyTelegramError } from '../telegram/errors.ts'
import type { TelegramSession } from '../telegram/session.ts'

export type AccountRow = typeof accounts.$inferSelect

export type SessionFactory = (account: AccountRow, ctx: { proxy: ProxyEndpoint | null; importSession: string | null }) => TelegramSession

export interface AccountHooks {
  /** the client is up: the codes module subscribes and catches up on missed messages */
  onSessionStarted?: (account: AccountRow, session: TelegramSession) => Promise<void> | void
  /** after the new status is stored: notifications */
  onStatusChanged?: (account: AccountRow, from: AccountStatus, to: AccountStatus) => Promise<void> | void
}

export interface AccountManagerOptions {
  /** waits before reconnect attempts after a network error; the last one repeats */
  retryDelaysMs?: number[]
  /** random spread between starts so dozens of clients do not connect in one burst */
  jitterMs?: number
}

export interface AccountManager {
  startAll(): Promise<void>
  /** reload one account from the database and run it if its status says so */
  sync(accountId: string): Promise<void>
  stop(accountId: string, logout?: boolean): Promise<void>
  onProxyDown(proxyId: string): Promise<void>
  onProxyUp(proxyId: string): Promise<void>
  onProxyChanged(proxyId: string): Promise<void>
  refreshProfiles(): Promise<void>
  sessions(accountId: string): Promise<AccountSessionDto[]>
  terminateSession(accountId: string, hash: string): Promise<void>
  isRunning(accountId: string): boolean
  stopAll(): Promise<void>
}

const DEFAULT_RETRY_DELAYS = [60_000, 120_000, 300_000, 600_000, 1_800_000]
const FROZEN_REASON = 'Telegram ограничил аккаунт (заморозка): коды продолжают приходить'

export class AccountNotRunningError extends Error {
  constructor() {
    super('Аккаунт сейчас не подключён')
    this.name = 'AccountNotRunningError'
  }
}

export function createAccountManager(deps: WorkerDeps, factory: SessionFactory, hooks: AccountHooks = {}, options: AccountManagerOptions = {}): AccountManager {
  const { db, cipher, settings, logger, bus } = deps
  const retryDelays = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS
  const jitterMs = options.jitterMs ?? 1_500
  const running = new Map<string, TelegramSession>()
  const retries = new Map<string, { attempt: number; timer?: NodeJS.Timeout }>()
  let shuttingDown = false

  const load = async (id: string) => (await db.select().from(accounts).where(eq(accounts.id, id)))[0]

  async function setStatus(account: AccountRow, status: AccountStatus, reason: string | null): Promise<AccountRow> {
    if (account.status === status && account.statusReason === reason) return account
    const [updated] = await db
      .update(accounts)
      .set({ status, statusReason: reason, statusChangedAt: new Date() })
      .where(eq(accounts.id, account.id))
      .returning()
    if (!updated) return account
    if (account.status !== status) {
      await writeAudit(db, { actor: { type: 'system' }, action: 'account.status', targetType: 'account', targetId: account.id, payload: { from: account.status, to: status, reason }, result: 'ok' }).catch(
        (err: unknown) => logger.error({ err }, 'accounts: failed to audit a status change'),
      )
      await hooks.onStatusChanged?.(updated, account.status, status)
    }
    await bus.publish({ type: 'accounts.changed', ids: [account.id] })
    return updated
  }

  /** The proxy the account must use, or why it cannot connect now. Direct accounts get null. */
  async function proxyFor(account: AccountRow): Promise<{ ok: true; endpoint: ProxyEndpoint | null } | { ok: false; reason: string }> {
    if (account.connectionMode === 'direct') return { ok: true, endpoint: null }
    if (!account.proxyId) return { ok: false, reason: 'Прокси не назначен' }
    const [proxy] = await db.select().from(proxies).where(eq(proxies.id, account.proxyId))
    if (!proxy) return { ok: false, reason: 'Прокси удалён' }
    if (proxy.disabledAt) return { ok: false, reason: 'Прокси отключён' }
    if (proxy.status === 'dead') return { ok: false, reason: 'Прокси не работает' }
    if (proxy.status === 'expired') return { ok: false, reason: 'Срок прокси истёк' }
    if (proxy.status === 'provisioning') return { ok: false, reason: 'Прокси ещё не выдан провайдером' }
    return {
      ok: true,
      endpoint: { type: proxy.type, host: proxy.host, port: proxy.port, username: proxy.username, password: proxy.passwordEnc ? cipher.decrypt(proxy.passwordEnc) : null },
    }
  }

  function clearRetry(id: string): void {
    const retry = retries.get(id)
    if (retry?.timer) clearTimeout(retry.timer)
    retries.delete(id)
  }

  function scheduleRetry(id: string): void {
    if (shuttingDown) return
    const attempt = (retries.get(id)?.attempt ?? 0) + 1
    const delay = retryDelays[Math.min(attempt - 1, retryDelays.length - 1)]!
    const timer = setTimeout(() => {
      retries.set(id, { attempt })
      void start(id)
    }, delay)
    timer.unref()
    retries.set(id, { attempt, timer })
  }

  async function stopSession(id: string, logout = false): Promise<void> {
    const session = running.get(id)
    if (!session) return
    running.delete(id)
    if (logout) await session.logOut().catch((err: unknown) => logger.warn({ err, accountId: id }, 'accounts: log out failed'))
    await session.stop().catch((err: unknown) => logger.warn({ err, accountId: id }, 'accounts: stop failed'))
  }

  async function handleError(id: string, err: unknown): Promise<void> {
    const { kind, reason } = classifyTelegramError(err)
    const account = await load(id)
    if (!account) return
    logger.warn({ accountId: id, kind, reason }, 'accounts: client error')
    if (kind === 'unauthorized' || kind === 'banned') {
      clearRetry(id)
      await stopSession(id)
      await setStatus(account, kind, reason)
      return
    }
    if (kind === 'frozen') {
      const session = running.get(id)
      const freeze = session ? await session.freezeInfo().catch(() => null) : null
      await db.update(accounts).set({ frozenUntil: freeze?.until ?? null }).where(eq(accounts.id, id))
      await setStatus(account, 'frozen', FROZEN_REASON)
      return
    }
    await stopSession(id)
    // a network failure through a proxy that has meanwhile died is the proxy's fault, not the account's
    const proxy = await proxyFor(account)
    if (!proxy.ok) {
      clearRetry(id)
      await setStatus(account, 'proxy_down', proxy.reason)
      return
    }
    await setStatus(account, 'error', reason)
    scheduleRetry(id)
  }

  async function start(id: string): Promise<void> {
    if (shuttingDown || running.has(id)) return
    let account = await load(id)
    if (!account || !(RUNNING_STATUSES.includes(account.status) || account.status === 'proxy_down')) return
    const proxy = await proxyFor(account)
    if (!proxy.ok) {
      await setStatus(account, 'proxy_down', proxy.reason)
      return
    }
    let session: TelegramSession
    try {
      session = factory(account, { proxy: proxy.endpoint, importSession: account.sessionImportEnc ? cipher.decrypt(account.sessionImportEnc) : null })
    } catch (err) {
      // e.g. the account's api_id is not configured: nothing to retry until settings change
      await setStatus(account, 'error', err instanceof Error ? err.message : String(err))
      return
    }
    // claimed before the first await: a second start() of the same account is a no-op
    running.set(id, session)
    try {
      const profile = await session.start()
      const freeze = await session.freezeInfo().catch(() => null)
      const [updated] = await db
        .update(accounts)
        .set({
          // the session now lives in the mtcute storage: never import the tdata copy again
          sessionImportEnc: null,
          tgUserId: profile.tgUserId,
          phone: profile.phone,
          username: profile.username,
          firstName: profile.firstName,
          lastName: profile.lastName,
          isPremium: profile.isPremium,
          dcId: profile.dcId ?? account.dcId,
          lastOkAt: new Date(),
          frozenUntil: freeze?.since ? freeze.until : null,
        })
        .where(eq(accounts.id, id))
        .returning()
      account = updated ?? account
      clearRetry(id)
      session.onError((err) => void handleError(id, err))
      account = await setStatus(account, freeze?.since ? 'frozen' : 'active', freeze?.since ? FROZEN_REASON : null)
      logger.info({ accountId: id, dcId: account.dcId, proxyId: account.proxyId, status: account.status }, 'accounts: connected')
      await hooks.onSessionStarted?.(account, session)
    } catch (err) {
      running.delete(id)
      await session.stop().catch(() => {})
      await handleError(id, err)
    }
  }

  async function accountsOnProxy(proxyId: string, statuses?: readonly AccountStatus[]): Promise<AccountRow[]> {
    return db
      .select()
      .from(accounts)
      .where(and(eq(accounts.proxyId, proxyId), statuses ? inArray(accounts.status, [...statuses]) : notInArray(accounts.status, ['paused', 'unauthorized', 'banned'])))
  }

  return {
    async startAll() {
      const rows = await db
        .select({ id: accounts.id })
        .from(accounts)
        .where(inArray(accounts.status, [...RUNNING_STATUSES, 'proxy_down']))
      const queue = rows.map((r) => r.id)
      const concurrency = Math.max(1, settings.get('worker.connectConcurrency'))
      await Promise.all(
        Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
          for (let id = queue.shift(); id; id = queue.shift()) {
            if (jitterMs > 0) await new Promise((resolve) => setTimeout(resolve, Math.random() * jitterMs))
            await start(id).catch((err: unknown) => logger.error({ err, accountId: id }, 'accounts: start crashed'))
          }
        }),
      )
    },
    async sync(accountId) {
      clearRetry(accountId)
      await stopSession(accountId)
      await start(accountId)
    },
    async stop(accountId, logout = false) {
      clearRetry(accountId)
      await stopSession(accountId, logout)
    },
    async onProxyDown(proxyId) {
      for (const account of await accountsOnProxy(proxyId)) {
        clearRetry(account.id)
        await stopSession(account.id)
        const proxy = await proxyFor(account)
        await setStatus(account, 'proxy_down', proxy.ok ? 'Прокси не работает' : proxy.reason)
      }
    },
    async onProxyUp(proxyId) {
      for (const account of await accountsOnProxy(proxyId, ['proxy_down'])) await start(account.id)
    },
    async onProxyChanged(proxyId) {
      for (const account of await accountsOnProxy(proxyId)) {
        if (running.has(account.id)) {
          await stopSession(account.id)
          await start(account.id)
        }
      }
    },
    async refreshProfiles() {
      for (const [id, session] of [...running]) {
        try {
          const [profile, freeze] = await Promise.all([session.profile(), session.freezeInfo().catch(() => null)])
          await db
            .update(accounts)
            .set({ phone: profile.phone, username: profile.username, firstName: profile.firstName, lastName: profile.lastName, isPremium: profile.isPremium, lastOkAt: new Date(), frozenUntil: freeze?.since ? freeze.until : null })
            .where(eq(accounts.id, id))
          const account = await load(id)
          if (account && freeze) await setStatus(account, freeze.since ? 'frozen' : 'active', freeze.since ? FROZEN_REASON : null)
        } catch (err) {
          await handleError(id, err)
        }
      }
    },
    async sessions(accountId) {
      const session = running.get(accountId)
      if (!session) throw new AccountNotRunningError()
      return session.sessions()
    },
    async terminateSession(accountId, hash) {
      const session = running.get(accountId)
      if (!session) throw new AccountNotRunningError()
      await session.terminateSession(hash)
    },
    isRunning: (accountId) => running.has(accountId),
    async stopAll() {
      shuttingDown = true
      for (const id of [...retries.keys()]) clearRetry(id)
      await Promise.allSettled([...running.keys()].map((id) => stopSession(id)))
    },
  }
}
