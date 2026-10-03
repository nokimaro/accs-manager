import type { Db } from '@workspace/db'
import type { EventBus, Logger, Redis, SettingsService } from '@workspace/server'
import type { Cipher } from '@workspace/shared/crypto'
import type { Env } from '@workspace/shared/env'
import type pg from 'pg'

export interface WorkerDeps {
  env: Env
  db: Db
  pool: pg.Pool
  /** general-purpose connection (heartbeat, locks); never in subscriber mode */
  redis: Redis
  /** BullMQ connection (maxRetriesPerRequest: null) */
  queueRedis: Redis
  bus: EventBus
  settings: SettingsService
  cipher: Cipher
  logger: Logger
  /** BullMQ key prefix; tests use their own */
  queuePrefix?: string
}
