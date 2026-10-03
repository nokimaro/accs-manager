import type { ApiError as ApiErrorBody } from '@workspace/shared/api'

export class ApiError extends Error {
  readonly status: number
  readonly body: ApiErrorBody | null
  constructor(status: number, body: ApiErrorBody | null) {
    super(body?.message ?? `HTTP ${status}`)
    this.name = 'ApiError'
    this.status = status
    this.body = body
  }
  /** per-field validation messages from a 400 response */
  get fields(): Record<string, string> {
    return this.body?.fields ?? {}
  }
}

/**
 * What to show for a failed request: the message of `field` from a validation answer, any field message when the
 * form has no matching input, or the server's message («HTTP 400» never reaches the admin when there is a better one).
 */
export function errorText(err: unknown, field?: string): string {
  if (err instanceof ApiError) {
    const fields = err.fields
    return (field ? fields[field] : undefined) ?? Object.values(fields)[0] ?? err.message
  }
  return err instanceof Error ? err.message : String(err)
}

/** Same-origin JSON fetch to /api; throws ApiError for non-2xx. */
export async function api<T>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const { json, ...rest } = init
  const headers = new Headers(rest.headers)
  if (json !== undefined) headers.set('content-type', 'application/json')
  const res = await fetch(`/api${path}`, { ...rest, headers, ...(json !== undefined ? { body: JSON.stringify(json) } : {}) })
  if (!res.ok) {
    let body: ApiErrorBody | null = null
    try {
      body = (await res.json()) as ApiErrorBody
    } catch {
      // not JSON
    }
    throw new ApiError(res.status, body)
  }
  // 202/204 and other empty answers carry no JSON
  const text = await res.text()
  return (text ? JSON.parse(text) : undefined) as T
}
