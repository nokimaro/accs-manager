import type { Db } from '@workspace/db'
import type { CommandClient, EventBus, Logger, Redis, SettingsService } from '@workspace/server'
import type { Cipher } from '@workspace/shared/crypto'
import type { Env } from '@workspace/shared/env'

export interface AppDeps {
  env: Env
  db: Db
  /** general-purpose connection (rate limiting); never put into subscriber mode */
  redis: Redis
  bus: EventBus
  settings: SettingsService
  /** encrypts proxy passwords and imported sessions with APP_ENCRYPTION_KEY */
  cipher: Cipher
  /** asks the worker to act (check a proxy, start an account, list sessions) */
  commands: CommandClient
  logger: Logger
  /** absolute path to the built SPA; static serving is skipped when undefined */
  webDistDir?: string
  /** SSE keep-alive interval; the session is re-validated on every beat (default 25 s) */
  sseHeartbeatMs?: number
}

export interface SessionAdmin {
  id: string
  login: string
}

export interface AuditOverrides {
  action?: string
  targetType?: string
  targetId?: string
  payload?: unknown
  /** for anonymous requests (login) once the actor is known */
  adminId?: string | null
}

export type AppEnv = {
  Variables: {
    deps: AppDeps
    clientIp: string
    admin: SessionAdmin | null
    sessionId: string | null
    audit: AuditOverrides
  }
}
