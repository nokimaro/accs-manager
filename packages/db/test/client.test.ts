import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest'
import { createDb } from '../src/client.ts'
import { createTestDatabase, type TestDatabase } from '../src/testing.ts'

let t: TestDatabase

beforeAll(async () => {
  t = await createTestDatabase(inject('pgAdminUrl'))
})
afterAll(async () => {
  await t.drop()
})

describe('createDb', () => {
  it('reports an idle connection dropped by the server to onError and keeps working', async () => {
    const onError = vi.fn()
    const handle = createDb(t.url, { max: 1, onError })
    try {
      const client = await handle.pool.connect()
      const { rows } = await client.query<{ pid: number }>('select pg_backend_pid() as pid')
      client.release()
      // what a Postgres restart does to idle connections: pg-pool then emits 'error' on the pool
      await t.db.execute(sql`select pg_terminate_backend(${rows[0]!.pid})`)
      await vi.waitFor(() => expect(onError).toHaveBeenCalledOnce())
      // pg-pool attaches the client (and its password) to the error; it must not reach a logger
      expect(onError.mock.calls[0]?.[0]).not.toHaveProperty('client')
      expect((await handle.db.execute(sql`select 1 as ok`)).rows).toEqual([{ ok: 1 }])
    } finally {
      await handle.close()
    }
  })

  it('always has a pool error listener, so an emitted error never throws', async () => {
    const handle = createDb(t.url)
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      expect(() => handle.pool.emit('error', new Error('connection lost'))).not.toThrow()
      expect(log).toHaveBeenCalledOnce()
      expect(String(log.mock.calls[0])).not.toContain(t.url)
    } finally {
      log.mockRestore()
      await handle.close()
    }
  })
})
