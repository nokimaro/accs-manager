import { fileURLToPath } from 'node:url'
import { serve } from '@hono/node-server'
import { createDb } from '@workspace/db'
import { createEventBus, createLogger, createRedis, exitOnFatalErrors, SettingsService } from '@workspace/server'
import { createCipher } from '@workspace/shared/crypto'
import { loadEnv } from '@workspace/shared/env'
import { createApp } from './app.ts'

const env = loadEnv()
const logger = createLogger({ level: env.LOG_LEVEL, pretty: env.NODE_ENV === 'development', name: 'api' })
exitOnFatalErrors(logger)
// a Postgres restart breaks idle connections: log it, the pool reconnects on demand
const database = createDb(env.DATABASE_URL, { onError: (err) => logger.warn({ err }, 'postgres: idle client error') })
const redis = createRedis(env.REDIS_URL, 'api', logger)
const subscriber = createRedis(env.REDIS_URL, 'api-sub', logger)
const bus = await createEventBus({ publisher: redis, subscriber, logger })
const settings = await SettingsService.create({ db: database.db, cipher: createCipher(env.APP_ENCRYPTION_KEY), bus, logger })

const app = createApp({
  env,
  db: database.db,
  redis,
  bus,
  settings,
  logger,
  webDistDir: fileURLToPath(new URL('../../web/dist', import.meta.url)),
})

const server = serve({ fetch: app.fetch, port: env.PORT }, (info) => logger.info({ port: info.port }, 'api listening'))

let stopping = false
async function shutdown(signal: string): Promise<void> {
  if (stopping) return
  stopping = true
  logger.info({ signal }, 'api: shutting down')
  // hard stop if anything below hangs
  setTimeout(() => process.exit(1), 10_000).unref()
  try {
    await new Promise<void>((resolve) => {
      server.close(() => resolve())
      if ('closeIdleConnections' in server) server.closeIdleConnections()
      // SSE streams never end on their own: give in-flight requests a moment, then drop the rest
      setTimeout(() => {
        if ('closeAllConnections' in server) server.closeAllConnections()
      }, 3_000).unref()
    })
    settings.close()
    await bus.close()
  } catch (err) {
    logger.error({ err }, 'api: error during shutdown')
  } finally {
    await Promise.allSettled([redis.quit(), subscriber.quit(), database.close()])
    process.exit(0)
  }
}
process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))
