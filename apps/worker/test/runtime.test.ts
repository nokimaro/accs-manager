import { existsSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCommandClient, readWorkerHeartbeat, startWorkerHeartbeat } from '@workspace/server'
import { Queue } from 'bullmq'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { acquireSingletonLock } from '../src/lock.ts'
import { createWorkerRuntime } from '../src/runtime.ts'
import { MAINTENANCE_QUEUE } from '../src/schedule.ts'
import { setupWorker, type TestWorker } from './helpers.ts'

let w: TestWorker
beforeAll(async () => {
  w = await setupWorker()
})
afterAll(async () => {
  await w.close()
})

describe('singleton lock', () => {
  it('lets a second worker wait until the first one releases', async () => {
    const onLost = vi.fn()
    const first = await acquireSingletonLock(w.deps.pool, { key: 'test:lock:a', onLost })
    const onWaiting = vi.fn()
    let secondAcquired = false
    const second = acquireSingletonLock(w.deps.pool, { key: 'test:lock:a', retryMs: 20, onWaiting, onLost }).then((lock) => {
      secondAcquired = true
      return lock
    })
    await vi.waitFor(() => expect(onWaiting).toHaveBeenCalledOnce())
    expect(secondAcquired).toBe(false)
    await first.release()
    await (await second).release()
    expect(onLost).not.toHaveBeenCalled()
  })

  it('reports a lost connection: the lock went with it', async () => {
    const onLost = vi.fn()
    const lock = await acquireSingletonLock(w.deps.pool, { key: 'test:lock:b', onLost })
    await w.deps.pool.query(
      `select pg_terminate_backend(pid) from pg_locks where locktype = 'advisory' and objid = hashtext('test:lock:b')::oid`,
    )
    await vi.waitFor(() => expect(onLost).toHaveBeenCalledOnce())
    await lock.release()
  })
})

it('heartbeat keeps a short-lived key and removes it on stop', async () => {
  // a key of our own: the api tests read the real one from the same Redis
  const key = `test:heartbeat:${w.deps.queuePrefix}`
  const stop = startWorkerHeartbeat(w.deps.redis, 'abc123', { intervalMs: 50, key })
  await vi.waitFor(async () => expect(await readWorkerHeartbeat(w.deps.redis, key)).toMatchObject({ version: 'abc123' }))
  expect(await w.deps.redis.pttl(key)).toBeGreaterThan(30_000)
  await stop()
  expect(await readWorkerHeartbeat(w.deps.redis, key)).toBeNull()
})

it('heartbeat also touches the file the container healthcheck reads, and removes it on stop', async () => {
  const aliveFile = join(tmpdir(), `accs-worker-alive-${w.deps.queuePrefix}`)
  const stop = startWorkerHeartbeat(w.deps.redis, 'abc123', { intervalMs: 50, key: `test:heartbeat:file:${w.deps.queuePrefix}`, aliveFile })
  await vi.waitFor(() => expect(existsSync(aliveFile)).toBe(true))
  const first = statSync(aliveFile).mtimeMs
  await vi.waitFor(() => expect(statSync(aliveFile).mtimeMs).toBeGreaterThan(first))
  await stop()
  expect(existsSync(aliveFile)).toBe(false)
})

describe('runtime', () => {
  it('plans maintenance from settings and re-plans when they change', async () => {
    const runtime = createWorkerRuntime(w.deps, { commands: {}, maintenance: {} })
    await runtime.start()
    const queue = new Queue(MAINTENANCE_QUEUE, { connection: w.deps.queueRedis, prefix: w.deps.queuePrefix })
    try {
      const every = async () => Object.fromEntries((await queue.getJobSchedulers()).map((s) => [s.key, Number(s.every)]))
      expect(await every()).toEqual({
        'proxies.checkDue': 60_000,
        'proxies.sync': 15 * 60_000,
        'accounts.refreshProfiles': 6 * 3_600_000,
        housekeeping: 3_600_000,
      })
      await w.deps.settings.update({ 'proxyStore.syncInterval': '5m' }, { adminId: null })
      await vi.waitFor(async () => expect((await every())['proxies.sync']).toBe(5 * 60_000))
    } finally {
      await queue.close()
      await runtime.stop()
    }
  })

  it('routes commands to their handlers and answers through BullMQ', async () => {
    const sessions = vi.fn(async ({ accountId }: { accountId: string }) => [{ hash: '1', accountId }])
    const runtime = createWorkerRuntime(w.deps, { commands: { 'account.sessions': sessions }, maintenance: {} })
    await runtime.start()
    const client = createCommandClient(w.deps.queueRedis, w.deps.queuePrefix)
    try {
      await expect(client.call({ type: 'account.sessions', accountId: 'acc-1' })).resolves.toEqual([{ hash: '1', accountId: 'acc-1' }])
      // a command without a handler fails instead of hanging
      await expect(client.call({ type: 'proxy.sync' }, 5_000)).rejects.toThrow(/no handler for proxy.sync/)
    } finally {
      await client.close()
      await runtime.stop()
    }
  })
})
