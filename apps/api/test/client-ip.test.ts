import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import { resolveClientIp } from '../src/lib/client-ip.ts'

async function ipOf(trustProxy: boolean, headers: Record<string, string> = {}): Promise<string> {
  const app = new Hono()
  app.get('/', (c) => c.text(resolveClientIp(c, trustProxy)))
  const res = await app.request('/', { headers }, { incoming: { socket: { remoteAddress: '10.0.0.9' } } })
  return res.text()
}

describe('resolveClientIp', () => {
  it('ignores X-Forwarded-For unless TRUST_PROXY is on', async () => {
    expect(await ipOf(false, { 'x-forwarded-for': '6.6.6.6' })).toBe('10.0.0.9')
  })

  it('takes the rightmost hop (appended by our proxy), not client-supplied entries', async () => {
    expect(await ipOf(true, { 'x-forwarded-for': '6.6.6.6, 7.7.7.7' })).toBe('7.7.7.7')
    expect(await ipOf(true, { 'x-forwarded-for': '2001:db8::1' })).toBe('2001:db8::1')
  })

  it('falls back to the socket address for garbage or missing headers', async () => {
    expect(await ipOf(true, { 'x-forwarded-for': 'not-an-ip' })).toBe('10.0.0.9')
    expect(await ipOf(true)).toBe('10.0.0.9')
  })
})
