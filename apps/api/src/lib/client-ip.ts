import { getConnInfo } from '@hono/node-server/conninfo'
import type { Context } from 'hono'

/**
 * With TRUST_PROXY the first X-Forwarded-For hop is used (set by our reverse proxy);
 * otherwise the socket address — a client-supplied X-Forwarded-For is ignored.
 */
export function resolveClientIp(c: Context, trustProxy: boolean): string {
  if (trustProxy) {
    const forwarded = c.req.header('x-forwarded-for')?.split(',')[0]?.trim()
    if (forwarded) return forwarded
  }
  try {
    return getConnInfo(c).remote.address ?? 'unknown'
  } catch {
    return 'unknown'
  }
}
