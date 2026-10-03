import { bool, duration, int, multiselect, secret, string } from './helpers.ts'
import type { SettingDef, SettingValueOf } from './types.ts'

export const notifyEventOptions = [
  { value: 'code', label: 'Новый код' },
  { value: 'proxy_down', label: 'Аккаунт остановлен: прокси недоступен' },
  { value: 'unauthorized', label: 'Сессия аккаунта отозвана' },
  { value: 'banned', label: 'Аккаунт забанен' },
  { value: 'frozen', label: 'Аккаунт заморожен' },
  { value: 'proxy_expiring', label: 'Истекает срок прокси' },
] as const

export const settingsDef = {
  // telegram
  'telegram.desktop.apiId': int({ group: 'telegram', label: 'Desktop: api_id', description: 'Для аккаунтов, импортированных из tdata.', default: null, min: 1, required: true, effect: 'new_connections' }),
  'telegram.desktop.apiHash': secret({ group: 'telegram', label: 'Desktop: api_hash', required: true, effect: 'new_connections' }),
  'telegram.desktop.deviceModel': string({ group: 'telegram', label: 'Desktop: модель устройства', default: null, required: true, effect: 'new_connections' }),
  'telegram.desktop.systemVersion': string({ group: 'telegram', label: 'Desktop: версия ОС', default: null, required: true, effect: 'new_connections' }),
  'telegram.desktop.appVersion': string({ group: 'telegram', label: 'Desktop: версия приложения', default: null, required: true, effect: 'new_connections' }),
  'telegram.desktop.langCode': string({ group: 'telegram', label: 'Desktop: код языка', default: 'ru', pattern: /^[a-z]{2}$/, patternMessage: 'Две латинские буквы, например ru', effect: 'new_connections' }),
  'telegram.own.apiId': int({ group: 'telegram', label: 'Свой api_id', description: 'Для новых сессий через QR. Берётся на my.telegram.org.', default: null, min: 1, required: true, effect: 'new_connections' }),
  'telegram.own.apiHash': secret({ group: 'telegram', label: 'Свой api_hash', required: true, effect: 'new_connections' }),
  'telegram.qrTimeout': duration({ group: 'telegram', label: 'Таймаут входа по QR', default: '5m', min: '1m', max: '15m' }),

  // notifications
  'notify.enabled': bool({ group: 'notifications', label: 'Уведомления включены', default: false }),
  'notify.botToken': secret({ group: 'notifications', label: 'Токен бота', description: 'Бот должен быть администратором канала.' }),
  'notify.chatId': string({ group: 'notifications', label: 'ID канала', description: 'Например -1001234567890.', default: null, pattern: /^-?\d+$/, patternMessage: 'Числовой ID, например -1001234567890' }),
  'notify.events': multiselect({ group: 'notifications', label: 'О чём уведомлять', options: notifyEventOptions, default: ['code', 'proxy_down', 'unauthorized', 'banned', 'frozen', 'proxy_expiring'] }),
  'notify.maxAge': duration({ group: 'notifications', label: 'Не слать коды старше', description: 'При догрузке истории после простоя.', default: '10m', min: '1m', max: '1d' }),

  // proxy
  'proxy.checkInterval': duration({ group: 'proxy', label: 'Интервал проверки', default: '5m', min: '1m', max: '1d' }),
  'proxy.failThreshold': int({ group: 'proxy', label: 'Неудач подряд до «dead»', default: 3, min: 1, max: 20 }),
  'proxy.expiryWarnDays': int({ group: 'proxy', label: 'Предупреждать об истечении за', default: 3, min: 0, max: 30, unit: 'дн.' }),

  // proxyStore
  'proxyStore.enabled': bool({ group: 'proxyStore', label: 'Синхронизация включена', default: false }),
  'proxyStore.apiKey': secret({ group: 'proxyStore', label: 'API-ключ', description: 'Часть URL https://proxy-store.com/api/{ключ}/…' }),
  'proxyStore.country': string({ group: 'proxyStore', label: 'Страна', default: 'kz', pattern: /^[a-z]{2}$/, patternMessage: 'Код страны из двух букв' }),
  'proxyStore.category': string({ group: 'proxyStore', label: 'Категория', default: 'for_all', maxLength: 64 }),
  'proxyStore.syncInterval': duration({ group: 'proxyStore', label: 'Интервал синхронизации', default: '15m', min: '1m', max: '1d' }),

  // worker
  'worker.connectConcurrency': int({ group: 'worker', label: 'Параллельных подключений', default: 5, min: 1, max: 50, effect: 'new_connections' }),
  'worker.profileRefreshInterval': duration({ group: 'worker', label: 'Обновлять профиль раз в', default: '6h', min: '10m', max: '7d' }),

  // import
  'import.maxZipSizeMb': int({ group: 'import', label: 'Максимальный размер zip', default: 50, min: 1, max: 1024, unit: 'МБ' }),
  'import.maxFiles': int({ group: 'import', label: 'Максимум файлов в архиве', default: 5000, min: 1, max: 100_000 }),
  'import.maxUnpackedSizeMb': int({ group: 'import', label: 'Максимум после распаковки', default: 500, min: 1, max: 10_240, unit: 'МБ' }),
  'import.draftTtl': duration({ group: 'import', label: 'Хранить неподтверждённый импорт', default: '1h', min: '5m', max: '1d' }),

  // retention
  'retention.codeMessagesDays': int({ group: 'retention', label: 'Хранить коды', default: 30, min: 1, max: 3650, unit: 'дн.' }),

  // security
  'security.sessionTtl': duration({ group: 'security', label: 'Срок сессии админа', default: '7d', min: '10m', max: '90d' }),
  'security.loginMaxAttempts': int({ group: 'security', label: 'Попыток входа в окне', default: 10, min: 3, max: 100 }),
  'security.loginWindow': duration({ group: 'security', label: 'Окно ограничения попыток', default: '15m', min: '1m', max: '1d' }),
} as const satisfies Record<string, SettingDef<unknown, unknown>>

export type SettingKey = keyof typeof settingsDef
export type SettingsValues = { [K in SettingKey]: SettingValueOf<(typeof settingsDef)[K]> }
export type NotifyEvent = (typeof notifyEventOptions)[number]['value']
