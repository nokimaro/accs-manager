import { z } from 'zod'

// ---- errors ----
export const apiErrorSchema = z.object({
  error: z.string(),
  message: z.string().optional(),
  fields: z.record(z.string(), z.string()).optional(),
})
export type ApiError = z.output<typeof apiErrorSchema>

// ---- auth ----
export const loginSchema = z.string().trim().toLowerCase().regex(/^[a-z0-9._-]{3,32}$/, 'Логин: 3–32 символа a-z, 0-9, точка, дефис, подчёркивание')
export const passwordSchema = z.string().min(10, 'Пароль не короче 10 символов').max(256)

export const loginInput = z.object({ login: z.string().trim().toLowerCase().min(1).max(64), password: z.string().min(1).max(256) })
export type LoginInput = z.output<typeof loginInput>

export const changePasswordInput = z.object({ currentPassword: z.string().min(1).max(256), newPassword: passwordSchema })
export type ChangePasswordInput = z.output<typeof changePasswordInput>

export const meResponse = z.object({ id: z.string(), login: z.string() })
export type MeResponse = z.output<typeof meResponse>

// ---- admins ----
export const adminDto = z.object({
  id: z.string(),
  login: z.string(),
  disabledAt: z.string().nullable(),
  lastLoginAt: z.string().nullable(),
  createdAt: z.string(),
})
export type AdminDto = z.output<typeof adminDto>

export const createAdminInput = z.object({ login: loginSchema, password: passwordSchema })
export type CreateAdminInput = z.output<typeof createAdminInput>

export const resetPasswordInput = z.object({ password: passwordSchema })
export type ResetPasswordInput = z.output<typeof resetPasswordInput>

// ---- audit ----
export const auditQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(10).max(100).default(50),
  adminId: z.uuid().optional(),
  action: z.string().max(100).optional(),
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
})
export type AuditQuery = z.output<typeof auditQuery>

export const auditEntryDto = z.object({
  id: z.string(),
  actorType: z.enum(['admin', 'system', 'cli']),
  adminId: z.string().nullable(),
  adminLogin: z.string().nullable(),
  action: z.string(),
  targetType: z.string().nullable(),
  targetId: z.string().nullable(),
  payload: z.unknown(),
  ip: z.string().nullable(),
  userAgent: z.string().nullable(),
  statusCode: z.number().nullable(),
  result: z.enum(['ok', 'error']),
  durationMs: z.number().nullable(),
  createdAt: z.string(),
})
export type AuditEntryDto = z.output<typeof auditEntryDto>

export const auditPage = z.object({ items: z.array(auditEntryDto), total: z.number(), page: z.number(), pageSize: z.number() })
export type AuditPage = z.output<typeof auditPage>

// ---- settings ----
export const settingStateDto = z.object({
  /** current effective value; always null for secrets */
  value: z.unknown(),
  /** secrets: whether a value is stored; others: value !== null */
  isSet: z.boolean(),
  /** an override row exists (differs from code default) */
  overridden: z.boolean(),
  updatedAt: z.string().nullable(),
  updatedBy: z.string().nullable(),
})
export type SettingStateDto = z.output<typeof settingStateDto>

export const settingsResponse = z.object({ items: z.record(z.string(), settingStateDto) })
export type SettingsResponse = z.output<typeof settingsResponse>

export const settingsPatchInput = z.object({ changes: z.record(z.string(), z.unknown()) })
export type SettingsPatchInput = z.output<typeof settingsPatchInput>
