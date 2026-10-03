import { isIP } from 'node:net'
import { getConnInfo } from '@hono/node-server/conninfo'
import type { Context } from 'hono'

/**
 * With TRUST_PROXY the rightmost X-Forwarded-For entry is used: that is the address our own reverse
 * proxy saw (proxies append to the header, so leftmost entries are client-controlled). Anything that
 * is not an IP falls back to the socket address; without TRUST_PROXY the header is ignored.
 */
export function resolveClientIp(c: Context, trustProxy: boolean): string {
  if (trustProxy) {
    const hops = c.req.header('x-forwarded-for')?.split(',') ?? []
    const last = hops[hops.length - 1]?.trim()
    if (last && isIP(last)) return last
  }
  try {
    return getConnInfo(c).remote.address ?? 'unknown'
  } catch {
    return 'unknown'
  }
}
