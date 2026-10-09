import { GATEWAY_DELIVERY_STATUSES, type GatewayDeliveryStatus } from '@workspace/shared/accounts'

const BASE_URL = 'https://gatewayapi.telegram.org'
const TIMEOUT_MS = 15_000

/** Gateway's RequestStatus, the fields the panel uses (https://core.telegram.org/gateway/api). */
export interface GatewayRequestStatus {
  requestId: string
  /** E.164 without the plus, as Gateway returns it */
  phoneNumber: string
  cost: number | null
  remainingBalance: number | null
  delivery: GatewayDeliveryStatus | null
}

/** Gateway said no: `code` is its error string, e.g. PHONE_NUMBER_NOT_AVAILABLE or FLOOD_WAIT_60. */
export class GatewayError extends Error {
  readonly code: string
  constructor(code: string) {
    super(`Telegram Gateway: ${code}`)
    this.name = 'GatewayError'
    this.code = code
  }
}

interface RawResponse {
  ok?: boolean
  error?: string
  result?: {
    request_id?: string
    phone_number?: string
    request_cost?: number
    remaining_balance?: number
    delivery_status?: { status?: string }
  }
}

/** A minimal Telegram Gateway API client; the token goes in the Authorization header only. */
export function createGateway(token: string, fetchFn: typeof fetch = fetch) {
  async function call(method: string, params: Record<string, unknown>): Promise<GatewayRequestStatus> {
    const res = await fetchFn(`${BASE_URL}/${method}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    const body = (await res.json().catch(() => ({}))) as RawResponse
    if (!body.ok || !body.result?.request_id) throw new GatewayError(body.error ?? `HTTP_${res.status}`)
    const status = body.result.delivery_status?.status
    return {
      requestId: String(body.result.request_id),
      phoneNumber: String(body.result.phone_number ?? ''),
      cost: typeof body.result.request_cost === 'number' ? body.result.request_cost : null,
      remainingBalance: typeof body.result.remaining_balance === 'number' ? body.result.remaining_balance : null,
      delivery: (GATEWAY_DELIVERY_STATUSES as readonly string[]).includes(status ?? '') ? (status as GatewayDeliveryStatus) : null,
    }
  }

  return {
    /** a new verification message with a code Telegram makes up; every call is a new (paid) request */
    sendVerificationMessage: (phoneE164: string, ttlSeconds: number) => call('sendVerificationMessage', { phone_number: phoneE164, code_length: 6, ttl: ttlSeconds }),
    checkVerificationStatus: (requestId: string) => call('checkVerificationStatus', { request_id: requestId }),
  }
}
