import { randomUUID } from 'node:crypto'
// typed inject('redisUrl'): the ProvidedContext augmentation lives in the test-db helper
import type {} from '@workspace/db/testing'
import { afterAll, describe, expect, inject, it, vi } from 'vitest'
import { createEventBus } from '../src/bus.ts'
import { createRedis } from '../src/redis.ts'

const url = inject('redisUrl')
const conns = [createRedis(url, 'a-pub'), createRedis(url, 'a-sub'), createRedis(url, 'b-pub'), createRedis(url, 'b-sub')]
afterAll(async () => {
  await Promise.all(conns.map((c) => c.quit()))
})

describe('event bus', () => {
  it('delivers typed events across instances and drops invalid payloads', async () => {
    const channel = `test:${randomUUID()}`
    const [aPub, aSub, bPub, bSub] = conns as [typeof conns[0], typeof conns[0], typeof conns[0], typeof conns[0]]
    const a = await createEventBus({ publisher: aPub, subscriber: aSub, channel })
    const b = await createEventBus({ publisher: bPub, subscriber: bSub, channel })
    const received = vi.fn()
    b.subscribe(received)

    await aPub.publish(channel, 'not json')
    await aPub.publish(channel, JSON.stringify({ type: 'unknown' }))
    await a.publish({ type: 'settings.changed', keys: ['notify.enabled'], by: null })

    await vi.waitFor(() => expect(received).toHaveBeenCalledTimes(1))
    expect(received).toHaveBeenCalledWith({ type: 'settings.changed', keys: ['notify.enabled'], by: null })
    await a.close()
    await b.close()
  })
})
