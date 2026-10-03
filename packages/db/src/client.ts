import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import pg from 'pg'
import * as schema from './schema.ts'

export type Db = NodePgDatabase<typeof schema>

export interface DbHandle {
  db: Db
  pool: pg.Pool
  close(): Promise<void>
}

export interface DbOptions {
  max?: number
  /**
   * Errors of idle connections (Postgres restarted, backend terminated, network blip). The pool drops
   * the broken connection and opens a new one on demand; without a listener pg-pool's 'error' event
   * would crash the process. Default: one console.error line with the message only.
   */
  onError?: (err: Error) => void
}

const logIdleError = (err: Error) => console.error(`postgres: idle client error: ${err.message}`)

export function createDb(url: string, options: DbOptions = {}): DbHandle {
  const pool = new pg.Pool({ connectionString: url, max: options.max ?? 10 })
  const onError = options.onError ?? logIdleError
  pool.on('error', (err) => {
    // pg-pool attaches the client to the error, and with it the connection password: never pass it on to a logger
    delete (err as Error & { client?: unknown }).client
    onError(err)
  })
  const db = drizzle({ client: pool, schema })
  return { db, pool, close: () => pool.end() }
}
