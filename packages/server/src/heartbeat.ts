import type { Redis } from './redis.ts'

/** The worker refreshes this key; the api reads it to show whether the worker is alive. */
export const HEARTBEAT_KEY = 'accs:worker:heartbeat'
const TTL_MS = 60_000

export interface Heartbeat {
  at: string
  pid: number
  version: string
}

/** `key` is for tests that share one Redis. */
export function startWorkerHeartbeat(redis: Redis, version: string, options: { intervalMs?: number; key?: string } = {}): () => Promise<void> {
  const key = options.key ?? HEARTBEAT_KEY
  const beat = () => {
    const value: Heartbeat = { at: new Date().toISOString(), pid: process.pid, version }
    redis.set(key, JSON.stringify(value), 'PX', TTL_MS).catch(() => {})
  }
  beat()
  const timer = setInterval(beat, options.intervalMs ?? 15_000)
  timer.unref()
  return async () => {
    clearInterval(timer)
    await redis.del(key).catch(() => {})
  }
}

/** The last heartbeat, or null when the worker has not reported for a minute. */
export async function readWorkerHeartbeat(redis: Redis, key = HEARTBEAT_KEY): Promise<Heartbeat | null> {
  const raw = await redis.get(key)
  if (!raw) return null
  try {
    return JSON.parse(raw) as Heartbeat
  } catch {
    return null
  }
}
