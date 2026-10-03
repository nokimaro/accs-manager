import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDb } from '@workspace/db'
import { createEventBus, createLogger, createRedis, exitOnFatalErrors, SettingsService, startWorkerHeartbeat } from '@workspace/server'
import { createCipher } from '@workspace/shared/crypto'
import { loadEnv } from '@workspace/shared/env'
import type { WorkerDeps } from './deps.ts'
import { acquireSingletonLock } from './lock.ts'
import { createMtcuteProxyChecker } from './proxies/checker.ts'
import { createProxyHealth } from './proxies/health.ts'
import { syncProxyStore } from './proxies/proxy-store.ts'
import { AccountNotRunningError, createAccountManager, type SessionFactory } from './accounts/manager.ts'
import { createCodeCollector } from './codes/collector.ts'
import { housekeeping } from './housekeeping.ts'
import { createNotifier } from './notify/notifier.ts'
import { createPhoneLogin } from './login/phone.ts'
import { createMtcutePhoneClient } from './login/phone-client.ts'
import { createMtcuteQrClient } from './qr/client.ts'
import { createQrLogin } from './qr/login.ts'
import { createMtcuteSession } from './telegram/mtcute-session.ts'
import { createAccountStorage, prepareMtcuteStorage } from './telegram/storage.ts'
import { createWorkerRuntime } from './runtime.ts'

const env = loadEnv()
const logger = createLogger({ level: env.LOG_LEVEL, pretty: env.NODE_ENV === 'development', name: 'worker' })
exitOnFatalErrors(logger)
const database = createDb(env.DATABASE_URL, { onError: (err) => logger.warn({ err }, 'postgres: idle client error') })

// one worker at a time: wait until a previous instance (e.g. during a deploy) lets go
const lock = await acquireSingletonLock(database.pool, {
  onWaiting: () => logger.info('worker: another instance holds the lock, waiting'),
  onLost: (err) => {
    logger.fatal({ err }, 'worker: lost the singleton lock connection, exiting')
    process.exit(1)
  },
})
logger.info('worker: lock acquired')

const redis = createRedis(env.REDIS_URL, 'worker', logger)
const subscriber = createRedis(env.REDIS_URL, 'worker-sub', logger)
const queueRedis = createRedis(env.REDIS_URL, 'worker-queues', logger, { forQueues: true })
const bus = await createEventBus({ publisher: redis, subscriber, logger })
const cipher = createCipher(env.APP_ENCRYPTION_KEY)
const settings = await SettingsService.create({ db: database.db, cipher, bus, logger })

// mtcute's own tables: migrate once before accounts load in parallel
await prepareMtcuteStorage(database.pool, database.db, cipher)

const deps: WorkerDeps = { env, db: database.db, pool: database.pool, redis, queueRedis, bus, settings, cipher, logger }
/** tdata accounts keep Telegram Desktop's identity; QR accounts use the owner's own api_id */
const sessionFactory: SessionFactory = (account, ctx) => {
  const own = account.clientProfile === 'own'
  const apiId = own ? settings.get('telegram.own.apiId') : settings.get('telegram.desktop.apiId')
  const apiHash = own ? settings.get('telegram.own.apiHash') : settings.get('telegram.desktop.apiHash')
  if (!apiId || !apiHash) throw new Error(own ? 'Не задан свой api_id / api_hash (Настройки → Telegram)' : 'Не задан Desktop api_id / api_hash')
  return createMtcuteSession({
    apiId,
    apiHash,
    device: account.device,
    storage: createAccountStorage(database.pool, database.db, cipher, account.id),
    proxy: ctx.proxy,
    importSession: ctx.importSession,
  })
}
const notifier = createNotifier(deps, fetch)
const codeCollector = createCodeCollector(deps, { onCode: notifier.onCode })
const accountManager = createAccountManager(deps, sessionFactory, { onSessionStarted: codeCollector.attach, onStatusChanged: notifier.onStatusChanged })

const qrLogin = createQrLogin(deps, createMtcuteQrClient, { onAccountCreated: accountManager.sync })
const phoneLogin = createPhoneLogin(deps, createMtcutePhoneClient, { onAccountCreated: accountManager.sync })

const proxyChecker = createMtcuteProxyChecker(() => ({ apiId: settings.get('telegram.desktop.apiId'), apiHash: settings.get('telegram.desktop.apiHash') }))
const proxyHealth = createProxyHealth(deps, proxyChecker, { onDown: accountManager.onProxyDown, onUp: accountManager.onProxyUp })
const proxyStoreHooks = { onChanged: accountManager.onProxyChanged, onDown: accountManager.onProxyDown }

const runtime = createWorkerRuntime(deps, {
  commands: {
    'proxy.check': async ({ proxyId }) => proxyHealth.checkById(proxyId),
    'proxy.sync': async () => syncProxyStore(deps, fetch, proxyStoreHooks),
    'account.sync': async ({ accountId }) => accountManager.sync(accountId),
    'qr.start': async (start) => qrLogin.run(start),
    'phone.start': async (start) => phoneLogin.run(start),
    'account.stop': async ({ accountId, logout }) => accountManager.stop(accountId, logout),
    'account.sessions': async ({ accountId }) => {
      try {
        return { sessions: await accountManager.sessions(accountId) }
      } catch (err) {
        if (err instanceof AccountNotRunningError) return { error: 'not_running' }
        throw err
      }
    },
    'account.terminateSession': async ({ accountId, hash }) => {
      try {
        await accountManager.terminateSession(accountId, hash)
        return { ok: true }
      } catch (err) {
        if (err instanceof AccountNotRunningError) return { error: 'not_running' }
        throw err
      }
    },
  },
  maintenance: {
    'proxies.checkDue': async () => {
      await proxyHealth.checkDue()
    },
    'proxies.sync': async () => {
      await syncProxyStore(deps, fetch, proxyStoreHooks)
    },
    'accounts.refreshProfiles': async () => accountManager.refreshProfiles(),
    housekeeping: async () => {
      const removed = await housekeeping(deps)
      const expiringProxies = await notifier.warnExpiringProxies()
      logger.info({ ...removed, expiringProxies }, 'worker: housekeeping done')
    },
  },
})
await runtime.start()
notifier.start()
// the file is what the container healthcheck in compose.yml looks at
const stopHeartbeat = startWorkerHeartbeat(redis, env.APP_VERSION, { aliveFile: join(tmpdir(), 'accs-worker-alive') })
logger.info('worker: started')
// connects in the background: commands and maintenance keep flowing meanwhile
accountManager.startAll().catch((err: unknown) => logger.error({ err }, 'worker: starting accounts failed'))

let stopping = false
async function shutdown(signal: string): Promise<void> {
  if (stopping) return
  stopping = true
  logger.info({ signal }, 'worker: shutting down')
  // compose gives 30 s (stop_grace_period); leave a margin
  setTimeout(() => process.exit(1), 25_000).unref()
  try {
    await runtime.stop()
    await accountManager.stopAll()
    await notifier.stop()
    await stopHeartbeat()
    settings.close()
    await bus.close()
    await lock.release()
  } catch (err) {
    logger.error({ err }, 'worker: error during shutdown')
  } finally {
    await Promise.allSettled([redis.quit(), subscriber.quit(), queueRedis.quit(), database.close()])
    process.exit(0)
  }
}
process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))
