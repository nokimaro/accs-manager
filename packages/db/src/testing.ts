import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { createDb, type DbHandle } from './client.ts'
import { runMigrations } from './migrate.ts'

declare module 'vitest' {
  export interface ProvidedContext {
    /** superuser URL of the shared test Postgres (see vitest.global-setup.ts) */
    pgAdminUrl: string
    redisUrl: string
  }
}

export interface TestDatabase extends DbHandle {
  url: string
  drop(): Promise<void>
}

async function adminQuery(adminUrl: string, sql: string): Promise<void> {
  const client = new pg.Client({ connectionString: adminUrl })
  await client.connect()
  try {
    await client.query(sql)
  } finally {
    await client.end()
  }
}

/** Creates an isolated, migrated database for one test file. */
export async function createTestDatabase(adminUrl: string): Promise<TestDatabase> {
  const name = `t_${randomUUID().replaceAll('-', '')}`
  await adminQuery(adminUrl, `CREATE DATABASE ${name}`)
  const url = new URL(adminUrl)
  url.pathname = `/${name}`
  const handle = createDb(url.toString(), { max: 5 })
  await runMigrations(handle.db)
  return {
    ...handle,
    url: url.toString(),
    async drop() {
      await handle.close()
      await adminQuery(adminUrl, `DROP DATABASE ${name} WITH (FORCE)`)
    },
  }
}
