import { createDb } from '@workspace/db'
import { createEventBus, createLogger, createRedis, exitOnFatalErrors, SettingsService, startWorkerHeartbeat } from '@workspace/server'
import { createCipher } from '@workspace/shared/crypto'
import { loadEnv } from '@workspace/shared/env'
import type { WorkerDeps } from './deps.ts'
import { acquireSingletonLock } from './lock.ts'
import { createMtcuteProxyChecker } from './proxies/checker.ts'
import { createProxyHealth } from './proxies/health.ts'
import { syncProxyStore } from './proxies/proxy-store.ts'
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

const deps: WorkerDeps = { env, db: database.db, pool: database.pool, redis, queueRedis, bus, settings, cipher, logger }
const proxyChecker = createMtcuteProxyChecker(() => ({ apiId: settings.get('telegram.desktop.apiId'), apiHash: settings.get('telegram.desktop.apiHash') }))
const proxyHealth = createProxyHealth(deps, proxyChecker)

const runtime = createWorkerRuntime(deps, {
  commands: {
    'proxy.check': async ({ proxyId }) => proxyHealth.checkById(proxyId),
    'proxy.sync': async () => syncProxyStore(deps, fetch),
  },
  maintenance: {
    'proxies.checkDue': async () => {
      await proxyHealth.checkDue()
    },
    'proxies.sync': async () => {
      await syncProxyStore(deps, fetch)
    },
  },
})
await runtime.start()
const stopHeartbeat = startWorkerHeartbeat(redis, env.APP_VERSION)
logger.info('worker: started')

let stopping = false
async function shutdown(signal: string): Promise<void> {
  if (stopping) return
  stopping = true
  logger.info({ signal }, 'worker: shutting down')
  // compose gives 30 s (stop_grace_period); leave a margin
  setTimeout(() => process.exit(1), 25_000).unref()
  try {
    await runtime.stop()
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
