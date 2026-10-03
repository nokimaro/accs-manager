import { randomBytes, randomUUID } from 'node:crypto'
import { createTestDatabase, type TestDatabase } from '@workspace/db/testing'
import { createEventBus, createLogger, createRedis, SettingsService, type CommandClient, type EventBus, type Redis } from '@workspace/server'
import type { WorkerCommand } from '@workspace/shared/commands'
import { createCipher } from '@workspace/shared/crypto'
import { loadEnv, type Env } from '@workspace/shared/env'
import { inject } from 'vitest'
import { createApp } from '../src/app.ts'
import type { AppDeps } from '../src/deps.ts'
import { createAdmin } from '../src/services/admins.ts'

export const ORIGIN = 'https://panel.test'

export interface TestApp {
  app: ReturnType<typeof createApp>
  deps: AppDeps
  t: TestDatabase
  bus: EventBus
  commands: FakeCommands
  close(): Promise<void>
}

/** Records what the api asks the worker; `respond` answers `call()` like the worker would. */
export class FakeCommands implements CommandClient {
  sent: WorkerCommand[] = []
  respond: (command: WorkerCommand) => unknown = () => null

  async send(command: WorkerCommand): Promise<void> {
    this.sent.push(command)
  }

  async call<T>(command: WorkerCommand): Promise<T> {
    this.sent.push(command)
    return (await this.respond(command)) as T
  }

  async close(): Promise<void> {}
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
  const cipher = createCipher(env.APP_ENCRYPTION_KEY)
  const commands = new FakeCommands()
  const deps: AppDeps = { env, db: t.db, redis, bus, settings, cipher, commands, logger: createLogger({ level: 'silent' }) }
  return {
    app: createApp(deps),
    deps,
    t,
    bus,
    commands,
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

export function uniqueLogin(prefix = 'adm'): string {
  return `${prefix}${randomUUID().slice(0, 8)}`
}

export function sessionCookie(res: Response): string {
  const raw = res.headers.get('set-cookie') ?? ''
  const match = /accs_session=([^;]+)/.exec(raw)
  if (!match) throw new Error(`no session cookie in: ${raw}`)
  return `accs_session=${match[1]}`
}

/** Creates an admin and logs in; returns its id, login and cookie. */
export async function loginAs(ta: TestApp, password = 'correct horse battery'): Promise<{ id: string; login: string; cookie: string }> {
  const login = uniqueLogin()
  const admin = await createAdmin(ta.deps.db, { login, password })
  const res = await send(ta.app, '/api/auth/login', { body: { login, password }, ip: `10.9.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` })
  if (res.status !== 200) throw new Error(`login failed: ${res.status}`)
  return { id: admin.id, login, cookie: sessionCookie(res) }
}
