import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { loginAs, send, setupApp, type TestApp } from './helpers.ts'

let ta: TestApp
beforeAll(async () => {
  ta = await setupApp()
})
afterAll(async () => {
  await ta.close()
})

async function readUntil(reader: ReadableStreamDefaultReader<Uint8Array>, needle: string): Promise<string> {
  const decoder = new TextDecoder()
  let text = ''
  while (!text.includes(needle)) {
    const { value, done } = await reader.read()
    if (done) break
    text += decoder.decode(value, { stream: true })
  }
  return text
}

describe('SSE /api/events', () => {
  it('streams bus events to an authenticated client', async () => {
    const { cookie } = await loginAs(ta)
    const res = await send(ta.app, '/api/events', { cookie })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/text\/event-stream/)
    expect(res.headers.get('x-accel-buffering')).toBe('no')
    const reader = res.body!.getReader()
    expect(await readUntil(reader, 'event: ready')).toContain('event: ready')
    await ta.bus.publish({ type: 'settings.changed', keys: ['notify.enabled'], by: null })
    const text = await readUntil(reader, 'settings.changed')
    expect(text).toContain('event: settings.changed')
    expect(text).toContain('"keys":["notify.enabled"]')
    await reader.cancel()
  })

  it('rejects anonymous clients', async () => {
    expect((await send(ta.app, '/api/events')).status).toBe(401)
  })
})
