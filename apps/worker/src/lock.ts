import type pg from 'pg'

/** Only one worker may hold Telegram sessions: two clients on one auth key end in AUTH_KEY_DUPLICATED. */
export const WORKER_LOCK_KEY = 'accs:worker'

export interface SingletonLock {
  release(): Promise<void>
}

export interface LockOptions {
  key?: string
  retryMs?: number
  /** called once if the lock is held elsewhere and we start waiting */
  onWaiting?: () => void
  /** the connection holding the lock broke: the lock is gone, the process must stop */
  onLost: (err: Error) => void
}

/**
 * Takes a session-level pg advisory lock on a dedicated pooled connection, polling until it is free
 * (a new worker started during a deploy waits for the old one to exit).
 */
export async function acquireSingletonLock(pool: pg.Pool, options: LockOptions): Promise<SingletonLock> {
  const key = options.key ?? WORKER_LOCK_KEY
  const client = await pool.connect()
  let waitingReported = false
  try {
    for (;;) {
      const { rows } = await client.query<{ ok: boolean }>('select pg_try_advisory_lock(hashtext($1)) as ok', [key])
      if (rows[0]?.ok) break
      if (!waitingReported) {
        waitingReported = true
        options.onWaiting?.()
      }
      await new Promise((resolve) => setTimeout(resolve, options.retryMs ?? 2_000))
    }
  } catch (err) {
    client.release(true)
    throw err
  }

  let released = false
  let lost = false
  // pg may emit several errors for one broken connection: report it once
  const onError = (err: Error) => {
    if (released || lost) return
    lost = true
    options.onLost(err)
  }
  client.on('error', onError)
  return {
    async release() {
      if (released) return
      released = true
      client.off('error', onError)
      // a query on a dead connection never settles: just destroy it, the lock died with it
      if (lost) {
        client.release(true)
        return
      }
      try {
        await client.query('select pg_advisory_unlock(hashtext($1))', [key])
        client.release()
      } catch {
        client.release(true)
      }
    },
  }
}
