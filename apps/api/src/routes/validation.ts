import type { Context } from 'hono'

interface IssueLike {
  path: readonly PropertyKey[]
  message: string
}

/** zValidator hook: 400 { error: 'validation', fields: { 'a.b': message } }. */
export function validationHook(result: { success: boolean; error?: { issues: readonly IssueLike[] } }, c: Context) {
  if (result.success || !result.error) return undefined
  const fields: Record<string, string> = {}
  for (const issue of result.error.issues) {
    const path = issue.path.map(String).join('.') || '_'
    fields[path] ??= issue.message
  }
  return c.json({ error: 'validation', fields }, 400)
}
