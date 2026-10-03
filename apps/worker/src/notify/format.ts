import { accountTitle, type AccountStatus } from '@workspace/shared/accounts'

const escapeHtml = (s: string) => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')

type AccountLike = { label: string | null; phone: string | null; username: string | null; tgUserId: number }

/** The phone when Telegram gave it, else label / @username / id — monospace, so it copies with a tap. */
export function accountTag(account: AccountLike): string {
  const title = account.phone ? `+${account.phone.replace(/^\+/, '')}` : accountTitle(account)
  return `<code>${escapeHtml(title)}</code>`
}

/** «+77001234567 получен код 575571» — the owner's one-line format. */
export function formatCodeMessage(account: AccountLike, code: string | null, text: string): string {
  if (code) return `${accountTag(account)} получен код <code>${escapeHtml(code)}</code>`
  return `${accountTag(account)} получено сообщение: ${escapeHtml(text.slice(0, 200))}`
}

const STATUS_TEXT: Partial<Record<AccountStatus, string>> = {
  proxy_down: 'остановлен — прокси недоступен',
  unauthorized: 'сессия отозвана',
  banned: 'аккаунт забанен',
  frozen: 'аккаунт заморожен Telegram',
}

export function formatStatusMessage(account: AccountLike, status: AccountStatus, reason: string | null): string {
  const what = STATUS_TEXT[status] ?? status
  return `⚠️ ${accountTag(account)} ${what}${reason ? `: ${escapeHtml(reason)}` : ''}`
}

export function formatProxyExpiringMessage(rows: { host: string; port: number; expiresAt: Date; account: AccountLike | null }[]): string {
  const lines = rows.map((r) => {
    const date = r.expiresAt.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', timeZone: 'UTC' })
    return `• <code>${escapeHtml(`${r.host}:${r.port}`)}</code> до ${date}${r.account ? ` — ${accountTag(r.account)}` : ''}`
  })
  return `⏳ Скоро заканчивается оплата прокси:\n${lines.join('\n')}`
}
