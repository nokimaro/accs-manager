/** An expected failure the client can act on: becomes `{ error: code, message }` with `status`. */
export class DomainError extends Error {
  readonly status: 400 | 404 | 409 | 422 | 503 | 504
  readonly code: string

  constructor(status: DomainError['status'], code: string, message: string) {
    super(message)
    this.name = 'DomainError'
    this.status = status
    this.code = code
  }
}
