import { auditLog } from '@workspace/db'
import type { AppEvent } from '@workspace/shared/events'
import { desc, eq } from '@workspace/db'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { loginAs, send, setupApp, type TestApp } from './helpers.ts'

let ta: TestApp
let cookie: string
let adminId: string
beforeAll(async () => {
  ta = await setupApp()
  ;({ cookie, id: adminId } = await loginAs(ta))
})
afterAll(async () => {
  await ta.close()
})

type Items = Record<string, { value: unknown; isSet: boolean; overridden: boolean; updatedBy: string | null }>

describe('settings API', () => {
  it('returns every setting with defaults and hides secret values', async () => {
    const { items } = (await (await send(ta.app, '/api/settings', { cookie })).json()) as { items: Items }
    expect(items['worker.connectConcurrency']).toMatchObject({ value: 5, overridden: false })
    expect(items['notify.botToken']).toMatchObject({ value: null, isSet: false })
  })

  it('updates values, broadcasts settings.changed and audits a redacted diff', async () => {
    const events: AppEvent[] = []
    const off = ta.bus.subscribe((e) => events.push(e))
    const res = await send(ta.app, '/api/settings', {
      method: 'PATCH',
      cookie,
      body: { changes: { 'worker.connectConcurrency': 8, 'notify.botToken': '42:TOKEN' } },
    })
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).not.toContain('42:TOKEN')
    const { items } = JSON.parse(text) as { items: Items }
    expect(items['worker.connectConcurrency']).toMatchObject({ value: 8, overridden: true, updatedBy: adminId })
    expect(items['notify.botToken']).toMatchObject({ value: null, isSet: true })
    await vi.waitFor(() => expect(events).toContainEqual({ type: 'settings.changed', keys: ['worker.connectConcurrency', 'notify.botToken'], by: adminId }))
    off()

    const [row] = await ta.t.db.select().from(auditLog).where(eq(auditLog.action, 'settings.update')).orderBy(desc(auditLog.id)).limit(1)
    expect(JSON.stringify(row?.payload)).not.toContain('42:TOKEN')
    expect(row?.payload).toEqual({
      diff: [
        { key: 'worker.connectConcurrency', from: 5, to: 8 },
        { key: 'notify.botToken', from: '[redacted]', to: '[redacted]' },
      ],
    })
  })

  it('rejects an empty secret, unknown keys and bad values without applying anything', async () => {
    const res = await send(ta.app, '/api/settings', {
      method: 'PATCH',
      cookie,
      body: { changes: { 'proxyStore.apiKey': '', 'no.such.key': 1, 'proxy.failThreshold': 4 } },
    })
    expect(res.status).toBe(400)
    const { fields } = (await res.json()) as { fields: Record<string, string> }
    expect(fields['proxyStore.apiKey']).toMatch(/Очистить/)
    expect(fields['no.such.key']).toBeDefined()
    expect(ta.deps.settings.get('proxy.failThreshold')).toBe(3)
  })

  it('null clears a secret', async () => {
    await send(ta.app, '/api/settings', { method: 'PATCH', cookie, body: { changes: { 'notify.botToken': 'x:y' } } })
    const res = await send(ta.app, '/api/settings', { method: 'PATCH', cookie, body: { changes: { 'notify.botToken': null } } })
    const { items } = (await res.json()) as { items: Items }
    expect(items['notify.botToken']).toMatchObject({ isSet: false, overridden: false })
  })

  it('requires auth', async () => {
    expect((await send(ta.app, '/api/settings')).status).toBe(401)
  })
})
