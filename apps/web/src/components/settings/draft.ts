import { settingsDef, type SettingKey } from '@workspace/shared/settings'

/** Unsaved edit of one setting: a new value, or "remove the override" (PATCH null). */
export type Draft = { kind: 'set'; value: unknown } | { kind: 'reset' }

export function draftError(key: SettingKey, draft: Draft | undefined): string | undefined {
  if (!draft || draft.kind === 'reset') return undefined
  const parsed = settingsDef[key].schema.safeParse(draft.value)
  return parsed.success ? undefined : (parsed.error.issues[0]?.message ?? 'Неверное значение')
}

export function draftsToChanges(drafts: Map<SettingKey, Draft>): Record<string, unknown> {
  const changes: Record<string, unknown> = {}
  for (const [key, draft] of drafts) changes[key] = draft.kind === 'reset' ? null : draft.value
  return changes
}
