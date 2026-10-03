import { randomBytes, randomUUID } from 'node:crypto'
import { createTestDatabase, type TestDatabase } from '@workspace/db/testing'
import { createEventBus, createLogger, createRedis, SettingsService, type Redis } from '@workspace/server'
import { createCipher } from '@workspace/shared/crypto'
import { loadEnv } from '@workspace/shared/env'
import { inject } from 'vitest'
import type { WorkerDeps } from '../src/deps.ts'

export interface TestWorker {
  deps: WorkerDeps
  t: TestDatabase
  close(): Promise<void>
}

/** Worker dependencies on an isolated database, a private queue prefix and bus channel. */
export async function setupWorker(): Promise<TestWorker> {
  const t = await createTestDatabase(inject('pgAdminUrl'))
  const redisUrl = inject('redisUrl')
  const redis: Redis = createRedis(redisUrl, 'test-worker')
  const sub: Redis = createRedis(redisUrl, 'test-worker-sub')
  const queueRedis: Redis = createRedis(redisUrl, 'test-worker-queues', undefined, { forQueues: true })
  const bus = await createEventBus({ publisher: redis, subscriber: sub, channel: `test:${randomUUID()}` })
  const env = loadEnv({
    DATABASE_URL: t.url,
    REDIS_URL: redisUrl,
    APP_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    PUBLIC_ORIGIN: 'http://localhost:5173',
    NODE_ENV: 'test',
  })
  const cipher = createCipher(env.APP_ENCRYPTION_KEY)
  const settings = await SettingsService.create({ db: t.db, cipher, bus })
  const deps: WorkerDeps = {
    env,
    db: t.db,
    pool: t.pool,
    redis,
    queueRedis,
    bus,
    settings,
    cipher,
    logger: createLogger({ level: 'silent' }),
    queuePrefix: `test-${randomUUID()}`,
  }
  return {
    deps,
    t,
    async close() {
      settings.close()
      await bus.close()
      await Promise.allSettled([redis.quit(), sub.quit(), queueRedis.quit()])
      await t.drop()
    },
  }
}
