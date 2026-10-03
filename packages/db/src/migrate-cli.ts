import { createDb } from './client.ts'
import { runMigrations } from './migrate.ts'

const url = process.env.DATABASE_URL
if (!url) {
  console.error('DATABASE_URL is required')
  process.exit(1)
}

const handle = createDb(url, { max: 1 })
try {
  await runMigrations(handle.db)
  console.log('migrations applied')
} finally {
  await handle.close()
}
