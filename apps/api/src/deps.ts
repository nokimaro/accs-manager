import type { Db } from '@workspace/db'
import type { EventBus, Logger, Redis, SettingsService } from '@workspace/server'
import type { Env } from '@workspace/shared/env'

export interface AppDeps {
  env: Env
  db: Db
  /** general-purpose connection (rate limiting); never put into subscriber mode */
  redis: Redis
  bus: EventBus
  settings: SettingsService
  logger: Logger
  /** absolute path to the built SPA; static serving is skipped when undefined */
  webDistDir?: string
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
