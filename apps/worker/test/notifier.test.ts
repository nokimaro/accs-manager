import { accounts, codeMessages, eq, proxies } from '@workspace/db'
import { Queue, UnrecoverableError } from 'bullmq'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { BotRateLimitError, sendBotMessage, type BotFetch } from '../src/notify/bot-api.ts'
import { formatCodeMessage } from '../src/notify/format.ts'
import { createNotifier, NOTIFY_QUEUE, type NotifyJob } from '../src/notify/notifier.ts'
import { setupWorker, type TestWorker } from './helpers.ts'

describe('message format', () => {
  it('is one short line: phone (label), then the code, both monospace', () => {
    expect(formatCodeMessage({ phone: '77066843426', label: 'OLIMP-1', username: null, tgUserId: 1 }, '437610', 'Your code is 437610')).toBe(
      '<code>+77066843426</code> (OLIMP-1) получен код <code>437610</code>',
    )
    expect(formatCodeMessage({ phone: '77001234567', label: null, username: null, tgUserId: 1 }, '575571', 'Your code is 575571')).toBe(
      '<code>+77001234567</code> получен код <code>575571</code>',
    )
    expect(formatCodeMessage({ phone: '77001234567', label: '<b>', username: null, tgUserId: 1 }, '575571', '')).toBe('<code>+77001234567</code> (&lt;b&gt;) получен код <code>575571</code>')
    expect(formatCodeMessage({ phone: null, label: null, username: 'nox', tgUserId: 1 }, '1234', '')).toBe('<code>@nox</code> получен код <code>1234</code>')
    expect(formatCodeMessage({ phone: null, label: 'a<b>', username: null, tgUserId: 1 }, null, 'Hi <there>')).toBe('<code>a&lt;b&gt;</code> получено сообщение: Hi &lt;there&gt;')
  })
})

describe('Bot API errors', () => {
  const answer = (status: number, body: unknown): BotFetch => async () => ({ ok: status < 300, status, json: async () => body })
  it('does not retry a wrong token or chat, retries rate limits and server errors', async () => {
    await expect(sendBotMessage(answer(400, { description: 'Bad Request: chat not found' }), 't', 'c', 'x')).rejects.toBeInstanceOf(UnrecoverableError)
    await expect(sendBotMessage(answer(429, { parameters: { retry_after: 3 } }), 't', 'c', 'x')).rejects.toBeInstanceOf(BotRateLimitError)
    await expect(sendBotMessage(answer(502, {}), 't', 'c', 'x')).rejects.not.toBeInstanceOf(UnrecoverableError)
  })
})

let w: TestWorker
let queue: Queue<NotifyJob>
beforeAll(async () => {
  w = await setupWorker()
  queue = new Queue<NotifyJob>(NOTIFY_QUEUE, { connection: w.deps.queueRedis, prefix: w.deps.queuePrefix })
})
afterAll(async () => {
  await queue.close()
  await w.close()
})
beforeEach(async () => {
  await queue.obliterate({ force: true })
  await w.t.db.delete(accounts)
  await w.t.db.delete(proxies)
  await w.deps.settings.update({ 'notify.enabled': true, 'notify.botToken': '123:TOKEN', 'notify.chatId': '-1003508630500' }, { adminId: null })
})

const device = { deviceModel: 'Desktop', systemVersion: 'Windows 11 x64', appVersion: '7.2.9 x64', langCode: 'ru' }
function fakeBot() {
  const calls: { url: string; body: Record<string, unknown> }[] = []
  const fetchFn: BotFetch = vi.fn(async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) })
    return { ok: true, status: 200, json: async () => ({ ok: true }) }
  })
  return { fetchFn, calls }
}
const jobs = async () => (await queue.getJobs(['waiting', 'delayed'])).map((j) => j.data)

describe('notifier', () => {
  it('sends a new code once, in the short format, and marks it notified', async () => {
    const [a] = await w.t.db.insert(accounts).values({ tgUserId: 1, phone: '77001234567', source: 'tdata', clientProfile: 'desktop', device, connectionMode: 'direct' }).returning()
    const [code] = await w.t.db.insert(codeMessages).values({ accountId: a!.id, tgMessageId: 5, date: new Date(), text: 'Your code is 575571', code: '575571' }).returning()
    const bot = fakeBot()
    const notifier = createNotifier(w.deps, bot.fetchFn)
    try {
      await notifier.onCode(code!, a!, true)
      expect(await jobs()).toEqual([{ kind: 'code', codeId: code!.id }])
      await notifier.process({ kind: 'code', codeId: code!.id })
      await notifier.process({ kind: 'code', codeId: code!.id })
      expect(bot.calls).toEqual([
        {
          url: 'https://api.telegram.org/bot123:TOKEN/sendMessage',
          body: { chat_id: '-1003508630500', text: '<code>+77001234567</code> получен код <code>575571</code>', parse_mode: 'HTML', link_preview_options: { is_disabled: true } },
        },
      ])
      expect((await w.t.db.select().from(codeMessages).where(eq(codeMessages.id, code!.id)))[0]!.notifiedAt).not.toBeNull()
    } finally {
      await notifier.stop()
    }
  })

  it('skips stale codes from history, and everything while notifications are off', async () => {
    const [a] = await w.t.db.insert(accounts).values({ tgUserId: 2, source: 'tdata', clientProfile: 'desktop', device, connectionMode: 'direct' }).returning()
    const [old] = await w.t.db.insert(codeMessages).values({ accountId: a!.id, tgMessageId: 1, date: new Date(Date.now() - 3_600_000), text: 'Your code is 1111' }).returning()
    const notifier = createNotifier(w.deps, fakeBot().fetchFn)
    try {
      await notifier.onCode(old!, a!, false)
      expect(await jobs()).toEqual([])
      await notifier.onCode(old!, a!, true)
      expect(await jobs()).toHaveLength(1)
      await queue.obliterate({ force: true })
      await w.deps.settings.update({ 'notify.enabled': false }, { adminId: null })
      await notifier.onCode(old!, a!, true)
      await notifier.onStatusChanged({ ...a!, statusReason: null }, 'active', 'banned')
      expect(await jobs()).toEqual([])
    } finally {
      await notifier.stop()
    }
  })

  it('warns about account problems and about proxies running out', async () => {
    const [p] = await w.t.db.insert(proxies).values({ source: 'proxy_store', externalId: '1', type: 'socks5', host: '194.53.188.22', port: 50101, status: 'ok', expiresAt: new Date(Date.now() + 2 * 86_400_000) }).returning()
    const [a] = await w.t.db.insert(accounts).values({ tgUserId: 3, phone: '77005550000', source: 'tdata', clientProfile: 'desktop', device, connectionMode: 'proxy', proxyId: p!.id }).returning()
    // a reused proxy: both accounts on one line
    await w.t.db.insert(accounts).values({ tgUserId: 4, phone: '77005550001', source: 'tdata', clientProfile: 'desktop', device, connectionMode: 'proxy', proxyId: p!.id })
    const bot = fakeBot()
    const notifier = createNotifier(w.deps, bot.fetchFn)
    try {
      await notifier.onStatusChanged({ ...a!, statusReason: 'Прокси не работает' }, 'active', 'proxy_down')
      expect(await notifier.warnExpiringProxies()).toBe(1)
      expect(await notifier.warnExpiringProxies()).toBe(0)
      for (const job of await jobs()) await notifier.process(job)
      // sorted: ⏳ (U+23F3) comes before ⚠️ (U+26A0)
      const texts = bot.calls.map((c) => c.body.text as string).sort()
      expect(texts).toHaveLength(2)
      expect(texts[1]).toBe('⚠️ <code>+77005550000</code> остановлен — прокси недоступен: Прокси не работает')
      expect(texts[0]).toMatch(/^⏳ Скоро заканчивается оплата прокси:\n• <code>194\.53\.188\.22:50101<\/code> до .+ — <code>\+77005550000<\/code>, <code>\+77005550001<\/code>$/)
    } finally {
      await notifier.stop()
    }
  })
})
