import type { z } from 'zod'

export type SettingType =
  | 'string'
  | 'text'
  | 'int'
  | 'decimal'
  | 'bool'
  | 'select'
  | 'multiselect'
  | 'duration'
  | 'secret'

/** When a changed value takes effect; shown next to the control in the UI. */
export type SettingEffect = 'immediate' | 'new_connections' | 'restart'

export type SettingGroupId =
  | 'telegram'
  | 'notifications'
  | 'proxy'
  | 'proxyStore'
  | 'worker'
  | 'import'
  | 'retention'
  | 'security'

export interface SettingGroup {
  id: SettingGroupId
  label: string
  description: string
}

export interface SettingOption<V extends string = string> {
  value: V
  label: string
}

export interface SettingMeta {
  type: SettingType
  group: SettingGroupId
  label: string
  description?: string
  effect: SettingEffect
  /** Sort order inside the group (definition order by default). */
  order: number
  /** UI warns when a required setting has no value. Never blocks the process. */
  required: boolean
  options?: readonly SettingOption[]
  /** UI hints only — the schema is the source of truth for validation. */
  min?: number | string
  max?: number | string
  step?: number
  unit?: string
}

/**
 * T — type of a value the admin can set (validated by `schema`).
 * D — type of the default; `null` means "not set" (no override row, feature may be off).
 * `null` is never stored: PATCH with `null` removes the override.
 */
export interface SettingDef<T = unknown, D extends T | null = T | null> {
  readonly schema: z.ZodType<T>
  readonly default: D
  readonly meta: SettingMeta
}

export type SettingValueOf<S> = S extends SettingDef<infer T, infer D> ? T | D : never
