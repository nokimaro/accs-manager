import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { send, setupApp, type TestApp } from './helpers.ts'

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
    expect(await res.json()).toEqual({ ok: true })
  })

  it('rejects state-changing requests from a foreign or missing Origin', async () => {
    for (const origin of [null, 'https://evil.test']) {
      const res = await send(ta.app, '/api/anything', { method: 'POST', origin })
      expect(res.status).toBe(403)
      expect(await res.json()).toMatchObject({ error: 'forbidden' })
    }
  })
})
