import { randomBytes, randomUUID } from 'node:crypto'
import { createTestDatabase, type TestDatabase } from '@workspace/db/testing'
import { createEventBus, createLogger, createRedis, SettingsService, type EventBus, type Redis } from '@workspace/server'
import { createCipher } from '@workspace/shared/crypto'
import { loadEnv, type Env } from '@workspace/shared/env'
import { inject } from 'vitest'
import { createApp } from '../src/app.ts'
import type { AppDeps } from '../src/deps.ts'

export const ORIGIN = 'https://panel.test'

export interface TestApp {
  app: ReturnType<typeof createApp>
  deps: AppDeps
  t: TestDatabase
  bus: EventBus
  close(): Promise<void>
}

export async function setupApp(envOverrides: Record<string, string> = {}): Promise<TestApp> {
  const t = await createTestDatabase(inject('pgAdminUrl'))
  const redisUrl = inject('redisUrl')
  const redis: Redis = createRedis(redisUrl, 'test')
  const sub: Redis = createRedis(redisUrl, 'test-sub')
  const bus = await createEventBus({ publisher: redis, subscriber: sub, channel: `test:${randomUUID()}` })
  const env: Env = loadEnv({
    DATABASE_URL: t.url,
    REDIS_URL: redisUrl,
    APP_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    PUBLIC_ORIGIN: ORIGIN,
    NODE_ENV: 'test',
    ...envOverrides,
  })
  const settings = await SettingsService.create({ db: t.db, cipher: createCipher(env.APP_ENCRYPTION_KEY), bus })
  const deps: AppDeps = { env, db: t.db, redis, bus, settings, logger: createLogger({ level: 'silent' }) }
  return {
    app: createApp(deps),
    deps,
    t,
    bus,
    async close() {
      settings.close()
      await bus.close()
      await Promise.allSettled([redis.quit(), sub.quit()])
      await t.drop()
    },
  }
}

export interface RequestOptions {
  method?: string
  body?: unknown
  cookie?: string
  origin?: string | null
  ip?: string
  headers?: Record<string, string>
}

/** Sends a request through the Hono app with a fake Node socket (for getConnInfo). */
export async function send(app: TestApp['app'], path: string, o: RequestOptions = {}): Promise<Response> {
  const headers = new Headers(o.headers)
  if (o.origin !== null) headers.set('origin', o.origin ?? ORIGIN)
  if (o.cookie) headers.set('cookie', o.cookie)
  let body: RequestInit['body']
  if (o.body instanceof FormData) body = o.body
  else if (o.body !== undefined) {
    headers.set('content-type', 'application/json')
    body = JSON.stringify(o.body)
  }
  return await app.request(
    path,
    { method: o.method ?? (body ? 'POST' : 'GET'), headers, ...(body ? { body } : {}) },
    { incoming: { socket: { remoteAddress: o.ip ?? '10.0.0.1' } } },
  )
}
