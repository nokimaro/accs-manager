import { randomUUID } from 'node:crypto'
import type {} from '@workspace/db/testing'
import { Worker } from 'bullmq'
import { afterAll, describe, expect, inject, it } from 'vitest'
import { COMMANDS_QUEUE, createCommandClient, WorkerTimeoutError } from '../src/queues.ts'
import { createRedis } from '../src/redis.ts'

const url = inject('redisUrl')
const conn = createRedis(url, 'queues-test', undefined, { forQueues: true })
// other test files share this Redis: a prefix of our own keeps their workers off our jobs
const prefix = `test-${randomUUID()}`
afterAll(async () => {
  await conn.quit()
})

describe('worker commands', () => {
  it('sends a command and returns the worker answer', async () => {
    const client = createCommandClient(conn, prefix)
    const worker = new Worker(
      COMMANDS_QUEUE,
      async (job) => (job.data.type === 'account.sessions' ? [{ hash: '1', current: true }] : null),
      { connection: conn.duplicate(), prefix },
    )
    try {
      await expect(client.call({ type: 'account.sessions', accountId: 'a' })).resolves.toEqual([{ hash: '1', current: true }])
    } finally {
      await worker.close()
      await client.close()
    }
  })

  it('rejects malformed commands before they reach the queue', async () => {
    const client = createCommandClient(conn, prefix)
    try {
      // the hash must be a decimal Telegram long
      await expect(client.send({ type: 'account.terminateSession', accountId: 'a', hash: 'abc' })).rejects.toThrow()
    } finally {
      await client.close()
    }
  })

  it('times out when no worker answers', async () => {
    const client = createCommandClient(conn, prefix)
    try {
      await expect(client.call({ type: 'proxy.sync' }, 300)).rejects.toBeInstanceOf(WorkerTimeoutError)
    } finally {
      await client.close()
    }
  })
})
