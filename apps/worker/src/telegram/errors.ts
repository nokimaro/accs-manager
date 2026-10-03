import { tl } from '@mtcute/core'

export type TelegramErrorKind = 'unauthorized' | 'banned' | 'frozen' | 'network' | 'other'

const UNAUTHORIZED = new Set([
  'AUTH_KEY_UNREGISTERED',
  'AUTH_KEY_INVALID',
  'AUTH_KEY_PERM_EMPTY',
  'AUTH_KEY_DUPLICATED',
  'SESSION_REVOKED',
  'SESSION_EXPIRED',
  'USER_DEACTIVATED',
])
const BANNED = new Set(['USER_DEACTIVATED_BAN', 'PHONE_NUMBER_BANNED'])
const FROZEN = new Set(['FROZEN_METHOD_INVALID', 'FROZEN_PARTICIPANT_MISSING'])

const REASONS: Record<string, string> = {
  AUTH_KEY_UNREGISTERED: 'Сессия завершена в Telegram (ключ больше не действует)',
  AUTH_KEY_DUPLICATED: 'Ключ сессии использовали одновременно с другого IP — Telegram его отозвал',
  SESSION_REVOKED: 'Сессию завершили из другого устройства',
  SESSION_EXPIRED: 'Сессия истекла',
  USER_DEACTIVATED: 'Аккаунт удалён',
  USER_DEACTIVATED_BAN: 'Аккаунт заблокирован Telegram',
  PHONE_NUMBER_BANNED: 'Номер заблокирован Telegram',
}

/** Sorts what Telegram (or the network) threw into what the account status should become. */
export function classifyTelegramError(err: unknown): { kind: TelegramErrorKind; reason: string } {
  if (tl.RpcError.is(err)) {
    const text = String(err.text)
    const reason = REASONS[text] ?? `${err.code} ${text}`
    if (UNAUTHORIZED.has(text)) return { kind: 'unauthorized', reason }
    if (BANNED.has(text)) return { kind: 'banned', reason }
    if (FROZEN.has(text)) return { kind: 'frozen', reason: 'Telegram ограничил аккаунт (заморозка)' }
    return { kind: 'other', reason }
  }
  const message = err instanceof Error ? err.message : String(err)
  return { kind: 'network', reason: message.slice(0, 300) }
}
