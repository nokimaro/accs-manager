import { Redis } from 'ioredis'
import type { Logger } from './logger.ts'

export type { Redis }

/**
 * `name` shows up in `CLIENT LIST`. An 'error' listener is always attached: without one ioredis
 * prints "Unhandled error event" on every reconnect attempt.
 */
export function createRedis(url: string, name: string, logger?: Logger): Redis {
  const redis = new Redis(url, { connectionName: name })
  redis.on('error', (err: Error) => logger?.warn({ err, connection: name }, 'redis: connection error'))
  return redis
}
