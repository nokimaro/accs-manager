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
  if (res.status === 204) return undefined as T
  return (await res.json()) as T
}
