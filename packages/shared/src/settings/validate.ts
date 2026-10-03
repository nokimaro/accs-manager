import { settingsDef, type SettingKey } from './definitions.ts'

export type SettingChangeResult =
  | { ok: true; changes: Map<SettingKey, unknown | null> }
  | { ok: false; errors: Record<string, string> }

export function isSettingKey(key: string): key is SettingKey {
  return Object.hasOwn(settingsDef, key)
}

/**
 * Validates a PATCH payload. `null` = remove the override (back to default / clear secret).
 * All-or-nothing: any error → nothing is applied.
 */
export function validateSettingChanges(input: Record<string, unknown>): SettingChangeResult {
  const errors: Record<string, string> = {}
  const changes = new Map<SettingKey, unknown | null>()
  for (const [key, value] of Object.entries(input)) {
    if (!isSettingKey(key)) {
      errors[key] = 'Неизвестная настройка'
      continue
    }
    if (value === null) {
      changes.set(key, null)
      continue
    }
    const parsed = settingsDef[key].schema.safeParse(value)
    if (parsed.success) changes.set(key, parsed.data)
    else errors[key] = parsed.error.issues[0]?.message ?? 'Неверное значение'
  }
  return Object.keys(errors).length > 0 ? { ok: false, errors } : { ok: true, changes }
}
