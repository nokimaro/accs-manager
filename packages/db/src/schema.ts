import { bigint, bigserial, boolean, customType, index, integer, pgTable, primaryKey, text, timestamp, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core'

const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
const updatedAt = () =>
  timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date())
const ts = (name: string) => timestamp(name, { withTimezone: true })

/**
 * jsonb that returns what was stored. node-postgres already parses jsonb, and drizzle's jsonb() then
 * JSON.parses string values once more, so a stored "-1001234567890", "0.25" or "true" came back as a
 * number or boolean. Same SQL type, so no migration.
 */
const jsonb = customType<{ data: unknown; driverData: unknown }>({
  dataType: () => 'jsonb',
  toDriver: (value) => JSON.stringify(value),
  fromDriver: (value) => value,
})

export const admins = pgTable(
  'admins',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    login: text('login').notNull(),
    passwordHash: text('password_hash').notNull(),
    disabledAt: timestamp('disabled_at', { withTimezone: true }),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('admins_login_key').on(t.login)],
)

export const adminSessions = pgTable(
  'admin_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tokenHash: text('token_hash').notNull(),
    adminId: uuid('admin_id')
      .notNull()
      .references(() => admins.id, { onDelete: 'cascade' }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    ip: text('ip'),
    userAgent: text('user_agent'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('admin_sessions_token_hash_key').on(t.tokenHash), index('admin_sessions_admin_id_idx').on(t.adminId)],
)

export const auditLog = pgTable(
  'audit_log',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    actorType: text('actor_type', { enum: ['admin', 'system', 'cli'] }).notNull(),
    adminId: uuid('admin_id').references(() => admins.id, { onDelete: 'set null' }),
    action: text('action').notNull(),
    targetType: text('target_type'),
    targetId: text('target_id'),
    payload: jsonb('payload'),
    ip: text('ip'),
    userAgent: text('user_agent'),
    statusCode: integer('status_code'),
    result: text('result', { enum: ['ok', 'error'] }).notNull(),
    durationMs: integer('duration_ms'),
    createdAt: createdAt(),
  },
  (t) => [
    index('audit_log_created_at_idx').on(t.createdAt),
    index('audit_log_admin_id_idx').on(t.adminId),
    index('audit_log_action_idx').on(t.action),
  ],
)

export const settings = pgTable('settings', {
  key: text('key').primaryKey(),
  /** plain JSON value, or { enc: "v1:..." } for secrets */
  value: jsonb('value').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  updatedBy: uuid('updated_by').references(() => admins.id, { onDelete: 'set null' }),
})

// ---- plan 2: proxies, Telegram accounts, codes ----

export const PROXY_SOURCES = ['manual', 'proxy_store'] as const
export const PROXY_TYPES = ['socks5', 'http'] as const
export const PROXY_STATUSES = ['provisioning', 'unchecked', 'ok', 'failing', 'dead', 'expired'] as const

export const proxies = pgTable(
  'proxies',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    source: text('source', { enum: PROXY_SOURCES }).notNull(),
    /** proxy-store id; null for manual proxies */
    externalId: text('external_id'),
    type: text('type', { enum: PROXY_TYPES }).notNull(),
    host: text('host').notNull(),
    port: integer('port').notNull(),
    username: text('username'),
    passwordEnc: text('password_enc'),
    tag: text('tag'),
    status: text('status', { enum: PROXY_STATUSES }).notNull().default('unchecked'),
    lastCheckAt: ts('last_check_at'),
    lastOkAt: ts('last_ok_at'),
    latencyMs: integer('latency_ms'),
    /** country of the exit IP as Telegram sees it (help.getNearestDc); shown only */
    tgCountry: text('tg_country'),
    /** when tgCountry was last asked from Telegram (a full MTProto exchange — done rarely) */
    tgCheckedAt: ts('tg_checked_at'),
    lastError: text('last_error'),
    failStreak: integer('fail_streak').notNull().default(0),
    expiresAt: ts('expires_at'),
    expiryWarnedAt: ts('expiry_warned_at'),
    providerMeta: jsonb('provider_meta'),
    disabledAt: ts('disabled_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('proxies_endpoint_key').on(t.type, t.host, t.port, t.username).nullsNotDistinct(),
    uniqueIndex('proxies_source_external_key').on(t.source, t.externalId),
    index('proxies_status_idx').on(t.status),
  ],
)

export const ACCOUNT_SOURCES = ['tdata', 'qr', 'phone'] as const
export const CLIENT_PROFILES = ['desktop', 'own'] as const
export const CONNECTION_MODES = ['proxy', 'direct'] as const
export const ACCOUNT_STATUSES = ['pending_check', 'active', 'paused', 'proxy_down', 'unauthorized', 'banned', 'frozen', 'error'] as const

/** initConnection parameters, fixed when the account is added */
export interface AccountDevice {
  deviceModel: string
  systemVersion: string
  appVersion: string
  langCode: string
}

export const accounts = pgTable(
  'accounts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tgUserId: bigint('tg_user_id', { mode: 'number' }).notNull(),
    phone: text('phone'),
    username: text('username'),
    firstName: text('first_name'),
    lastName: text('last_name'),
    isPremium: boolean('is_premium').notNull().default(false),
    dcId: integer('dc_id'),
    label: text('label'),
    note: text('note'),
    source: text('source', { enum: ACCOUNT_SOURCES }).notNull(),
    clientProfile: text('client_profile', { enum: CLIENT_PROFILES }).notNull(),
    device: jsonb('device').$type<AccountDevice>().notNull(),
    connectionMode: text('connection_mode', { enum: CONNECTION_MODES }).notNull(),
    /** several accounts may share one proxy («переиспользовать прокси») */
    proxyId: uuid('proxy_id').references(() => proxies.id, { onDelete: 'set null' }),
    status: text('status', { enum: ACCOUNT_STATUSES }).notNull().default('pending_check'),
    statusReason: text('status_reason'),
    statusChangedAt: timestamp('status_changed_at', { withTimezone: true }).notNull().defaultNow(),
    lastOkAt: ts('last_ok_at'),
    /** set while Telegram reports the account frozen (help.getAppConfig.freeze_until_date) */
    frozenUntil: ts('frozen_until'),
    /** one-time mtcute string session from a tdata import (encrypted); the worker imports and clears it */
    sessionImportEnc: text('session_import_enc'),
    /** the account's cloud (2FA) password when the panel knows it; written by the worker after Telegram accepted it */
    cloudPasswordEnc: text('cloud_password_enc'),
    /**
     * a password set together with a new recovery email: Telegram may apply it only once the email is confirmed,
     * so it waits here until Telegram accepts it (then it becomes cloud_password_enc)
     */
    cloudPasswordPendingEnc: text('cloud_password_pending_enc'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('accounts_tg_user_id_key').on(t.tgUserId), index('accounts_proxy_id_idx').on(t.proxyId), index('accounts_status_idx').on(t.status)],
)

/** mtcute auth keys, encrypted with APP_ENCRYPTION_KEY (see apps/worker storage) */
export const accountAuth = pgTable(
  'account_auth',
  {
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    dcId: integer('dc_id').notNull(),
    authKeyEnc: text('auth_key_enc').notNull(),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ columns: [t.accountId, t.dcId] })],
)

export const IMPORT_BATCH_STATUSES = ['ready', 'confirmed'] as const
export const IMPORT_DECISIONS = ['pending', 'imported', 'skipped'] as const

export const importBatches = pgTable('import_batches', {
  id: uuid('id').primaryKey().defaultRandom(),
  adminId: uuid('admin_id').references(() => admins.id, { onDelete: 'set null' }),
  filename: text('filename').notNull(),
  status: text('status', { enum: IMPORT_BATCH_STATUSES }).notNull().default('ready'),
  createdAt: createdAt(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
})

export const importItems = pgTable(
  'import_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    batchId: uuid('batch_id')
      .notNull()
      .references(() => importBatches.id, { onDelete: 'cascade' }),
    pathInArchive: text('path_in_archive').notNull(),
    accountIndex: integer('account_index').notNull(),
    tgUserId: bigint('tg_user_id', { mode: 'number' }).notNull(),
    dcId: integer('dc_id').notNull(),
    /** mtcute string session (encrypted) */
    sessionEnc: text('session_enc').notNull(),
    duplicateOf: uuid('duplicate_of').references(() => accounts.id, { onDelete: 'set null' }),
    decision: text('decision', { enum: IMPORT_DECISIONS }).notNull().default('pending'),
    accountId: uuid('account_id').references(() => accounts.id, { onDelete: 'set null' }),
    error: text('error'),
  },
  (t) => [index('import_items_batch_id_idx').on(t.batchId)],
)

export const codeMessages = pgTable(
  'code_messages',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    tgMessageId: integer('tg_message_id').notNull(),
    date: timestamp('date', { withTimezone: true }).notNull(),
    text: text('text').notNull(),
    code: text('code'),
    notifiedAt: ts('notified_at'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('code_messages_account_message_key').on(t.accountId, t.tgMessageId), index('code_messages_date_idx').on(t.date)],
)
