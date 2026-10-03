import type { Redis } from 'ioredis'

/**
 * Failed-attempt limiter: only failures are counted, so legitimate logins never lock anyone out.
 * Window starts at the first failure (PEXPIRE NX, Redis ≥ 7).
 */
export async function checkLimit(redis: Redis, key: string, limit: number): Promise<{ limited: boolean; retryAfterSec: number }> {
  const [[, count], [, ttl]] = (await redis.multi().get(key).pttl(key).exec()) as [[null, string | null], [null, number]]
  return { limited: Number(count ?? 0) >= limit, retryAfterSec: Math.max(1, Math.ceil(ttl / 1000)) }
}

export async function recordFailure(redis: Redis, key: string, windowMs: number): Promise<void> {
  await redis.multi().incr(key).pexpire(key, windowMs, 'NX').exec()
}

export async function clearFailures(redis: Redis, key: string): Promise<void> {
  await redis.del(key)
}
