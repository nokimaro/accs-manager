import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ORIGIN, send, setupApp, type TestApp } from './helpers.ts'

let ta: TestApp
beforeAll(async () => {
  ta = await setupApp()
})
afterAll(async () => {
  await ta.close()
})

describe('app shell', () => {
  it('reports health of Postgres and Redis', async () => {
    const res = await send(ta.app, '/api/healthz')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, version: 'dev' })
  })

  it('reports the deployed version baked into the image', async () => {
    const versioned = await setupApp({ APP_VERSION: 'abc1234' })
    try {
      expect(await (await send(versioned.app, '/api/healthz')).json()).toEqual({ ok: true, version: 'abc1234' })
    } finally {
      await versioned.close()
    }
  })

  it('sends security headers and no-store on API responses, but leaves HSTS to the reverse proxy', async () => {
    for (const res of [await send(ta.app, '/api/healthz'), await send(ta.app, '/api/auth/me')]) {
      expect(res.headers.get('x-content-type-options')).toBe('nosniff')
      expect(res.headers.get('x-frame-options')).toBe('SAMEORIGIN')
      expect(res.headers.get('cache-control')).toBe('no-store')
      expect(res.headers.has('strict-transport-security')).toBe(false)
    }
  })

  it('rejects state-changing requests from a foreign or missing Origin', async () => {
    for (const origin of [null, 'https://evil.test']) {
      const res = await send(ta.app, '/api/anything', { method: 'POST', origin })
      expect(res.status).toBe(403)
      expect(await res.json()).toMatchObject({ error: 'forbidden' })
    }
  })
})

describe('request body limit', () => {
  const MiB = 1024 * 1024
  const tooLarge = JSON.stringify({ login: 'x', password: 'p'.repeat(2 * MiB) })

  it('rejects a body over 1 MiB declared by Content-Length with 413', async () => {
    const res = await ta.app.request('/api/auth/login', {
      method: 'POST',
      headers: { origin: ORIGIN, 'content-type': 'application/json', 'content-length': String(tooLarge.length) },
      body: tooLarge,
    })
    expect(res.status).toBe(413)
    expect(await res.json()).toMatchObject({ error: 'payload_too_large' })
  })

  it('rejects a chunked body without Content-Length once it passes 1 MiB, even before auth', async () => {
    const chunk = new TextEncoder().encode('x'.repeat(64 * 1024))
    let sent = 0
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent >= 2 * MiB) return controller.close()
        sent += chunk.length
        controller.enqueue(chunk)
      },
    })
    const res = await ta.app.request('/api/admins', {
      method: 'POST',
      headers: { origin: ORIGIN, 'content-type': 'application/json' },
      body,
      duplex: 'half',
    } as RequestInit)
    expect(res.status).toBe(413)
    expect(await res.json()).toMatchObject({ error: 'payload_too_large' })
    expect(sent).toBeLessThan(2 * MiB) // stopped reading early
  })
})
