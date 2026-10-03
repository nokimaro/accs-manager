export * from './client.ts'
export * from './migrate.ts'
export * as schema from './schema.ts'
export {
  accountAuth,
  accounts,
  admins,
  adminSessions,
  auditLog,
  codeMessages,
  importBatches,
  importItems,
  proxies,
  settings,
  type AccountDevice,
} from './schema.ts'

// one drizzle-orm instance for every workspace package: apps import the operators from here, not from drizzle-orm
// (a second copy — e.g. a peer variant pulled by @mtcute/node's optional sqlite — makes their SQL types incompatible)
export { and, asc, count, desc, eq, getTableColumns, gt, gte, inArray, isNotNull, isNull, lt, lte, ne, not, notInArray, or, sql, type SQL } from 'drizzle-orm'
