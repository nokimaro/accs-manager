import { PostgreSqlContainer } from '@testcontainers/postgresql'
import { RedisContainer } from '@testcontainers/redis'
import type { TestProject } from 'vitest/node'
import type {} from './packages/db/src/testing.ts'

/**
 * One Postgres 18 + Redis 8 for the whole run. In CI, service containers are passed via
 * TEST_PG_URL / TEST_REDIS_URL and testcontainers is skipped.
 */
export default async function setup(project: TestProject) {
  if (process.env.TEST_PG_URL && process.env.TEST_REDIS_URL) {
    project.provide('pgAdminUrl', process.env.TEST_PG_URL)
    project.provide('redisUrl', process.env.TEST_REDIS_URL)
    return
  }
  const [pg, redis] = await Promise.all([
    new PostgreSqlContainer('postgres:18-trixie').start(),
    new RedisContainer('redis:8-trixie').start(),
  ])
  project.provide('pgAdminUrl', pg.getConnectionUri())
  project.provide('redisUrl', redis.getConnectionUrl())
  return async () => {
    await Promise.all([pg.stop(), redis.stop()])
  }
}
