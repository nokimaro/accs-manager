import { UnrecoverableError } from 'bullmq'

export type BotFetch = (url: string, init: { method: 'POST'; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>

/** Telegram asked us to wait: BullMQ retries with backoff. */
export class BotRateLimitError extends Error {
  constructor(retryAfter: number) {
    super(`Bot API rate limit, retry after ${retryAfter}s`)
    this.name = 'BotRateLimitError'
  }
}

/**
 * sendMessage to the notification channel. A wrong token or chat id (400/401/403) is not retried —
 * it will not fix itself; network errors, 429 and 5xx are.
 */
export async function sendBotMessage(fetchFn: BotFetch, token: string, chatId: string, html: string): Promise<void> {
  const res = await fetchFn(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: html, parse_mode: 'HTML', link_preview_options: { is_disabled: true } }),
    signal: AbortSignal.timeout(15_000),
  })
  if (res.ok) return
  const body = (await res.json().catch(() => ({}))) as { description?: string; parameters?: { retry_after?: number } }
  if (res.status === 429) throw new BotRateLimitError(body.parameters?.retry_after ?? 5)
  const message = `Bot API ${res.status}: ${body.description ?? 'error'}`
  if (res.status >= 400 && res.status < 500) throw new UnrecoverableError(message)
  throw new Error(message)
}
