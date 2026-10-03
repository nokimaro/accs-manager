import { fileURLToPath } from 'node:url'
import { serve } from '@hono/node-server'
import { createDb } from '@workspace/db'
import { createEventBus, createLogger, createRedis, SettingsService } from '@workspace/server'
import { createCipher } from '@workspace/shared/crypto'
import { loadEnv } from '@workspace/shared/env'
import { createApp } from './app.ts'

const env = loadEnv()
const logger = createLogger({ level: env.LOG_LEVEL, pretty: env.NODE_ENV === 'development', name: 'api' })
const database = createDb(env.DATABASE_URL)
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
  server.close()
  // open SSE streams would keep close() waiting forever
  if ('closeAllConnections' in server) server.closeAllConnections()
  settings.close()
  await bus.close()
  await Promise.allSettled([redis.quit(), subscriber.quit(), database.close()])
  process.exit(0)
}
process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))
