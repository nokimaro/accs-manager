import type { Redis } from 'ioredis'

/**
 * Attempt limiter. An attempt is reserved atomically (INCR) BEFORE the slow password check, so a
 * parallel burst cannot slip past the limit; a successful attempt is refunded / cleared afterwards,
 * so legitimate logins never lock anyone out. The window starts at the first attempt (PEXPIRE NX, Redis ≥ 7).
 */
export async function reserveAttempt(redis: Redis, key: string, windowMs: number): Promise<{ count: number; retryAfterSec: number }> {
  const res = await redis.multi().incr(key).pexpire(key, windowMs, 'NX').pttl(key).exec()
  if (!res) throw new Error('rate limit: transaction aborted')
  for (const [err] of res) if (err) throw err
  const count = Number(res[0]?.[1])
  const ttl = Number(res[2]?.[1])
  return { count, retryAfterSec: Math.max(1, Math.ceil(ttl / 1000)) }
}

const REFUND = "if redis.call('EXISTS', KEYS[1]) == 1 then return redis.call('DECR', KEYS[1]) end return 0"

/** Gives back one reserved attempt without ever creating a key. */
export async function refundAttempt(redis: Redis, key: string): Promise<void> {
  await redis.eval(REFUND, 1, key)
}

export async function clearAttempts(redis: Redis, key: string): Promise<void> {
  await redis.del(key)
}
