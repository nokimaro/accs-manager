import { bool, duration, int, multiselect, secret, string } from './helpers.ts'
import type { SettingDef, SettingValueOf } from './types.ts'
import { units } from './units.ts'

export const notifyEventOptions = [
  { value: 'code', label: 'Новый код' },
  { value: 'proxy_down', label: 'Аккаунт остановлен: прокси недоступен' },
  { value: 'unauthorized', label: 'Сессия аккаунта отозвана' },
  { value: 'banned', label: 'Аккаунт забанен' },
  { value: 'frozen', label: 'Аккаунт заморожен' },
  { value: 'proxy_expiring', label: 'Истекает срок прокси' },
] as const

/** What Telegram Desktop 7.2.9 portable (Windows x64) reports — see the comment at the telegram.desktop.* settings. */
export const TDESKTOP = {
  apiId: 2040,
  apiHash: 'b18441a1ff607e10a989891a5462e627',
  deviceModel: 'Desktop',
  systemVersion: 'Windows 11 x64',
  appVersion: '7.2.9 x64',
} as const

const SECRET_NOTE = 'Хранится зашифрованным и после сохранения не показывается: его можно только заменить или очистить.'
const DEVICE_NOTE =
  'Значение записывается в аккаунт при добавлении, поэтому смена настройки касается только аккаунтов, добавленных после неё.'

export const settingsDef = {
  // telegram
  // Defaults reproduce what the official Telegram Desktop 7.2.9 (portable, Windows x64) sends in initConnection:
  // app_version = AppVersionStr + " x64" (tdesktop mtproto/session_private.cpp), system_version = "Windows 11 x64"
  // and device_model = BIOS product name or "Desktop" when there is none (desktop-app/lib_base base_info_win.cpp).
  // api_id/api_hash are the public values of the official app. Bump appVersion when Telegram Desktop updates.
  'telegram.desktop.apiId': int({
    group: 'telegram', label: 'Desktop: api_id', default: TDESKTOP.apiId, min: 1, required: true, effect: 'new_connections',
    description: 'api_id Telegram Desktop — для аккаунтов, импортированных из tdata.',
    help: `Идентификатор приложения, от имени которого подключаются аккаунты из tdata. Сессии в tdata созданы официальным Telegram Desktop, поэтому здесь его api_id (по умолчанию ${TDESKTOP.apiId}): иначе для Telegram сессия резко «превратится» в другое приложение.\n\nМенять не нужно.`,
  }),
  'telegram.desktop.apiHash': string({
    group: 'telegram', label: 'Desktop: api_hash', default: TDESKTOP.apiHash, pattern: /^[0-9a-f]{32}$/, patternMessage: '32 шестнадцатеричных символа', required: true, effect: 'new_connections',
    description: 'api_hash Telegram Desktop — в пару к Desktop: api_id.',
    help: 'Ключ официального приложения Telegram Desktop, парный к его api_id. Значение публичное и одинаковое у всех копий Telegram Desktop, поэтому хранится открыто, а не как секрет.\n\nМенять не нужно.',
  }),
  'telegram.desktop.deviceModel': string({
    group: 'telegram', label: 'Desktop: модель устройства', default: TDESKTOP.deviceModel, required: true, effect: 'new_connections',
    description: 'Как устройство аккаунта из tdata видно в «Активных сеансах».',
    help: `Модель устройства, которую клиент сообщает Telegram. Telegram Desktop на Windows берёт её из BIOS (модель ПК или материнской платы), а если там пусто — пишет «Desktop»; это значение и стоит по умолчанию.\n\nЧтобы сессии выглядели как ваш компьютер, посмотрите в Telegram: Настройки → Устройства → текущий сеанс Telegram Desktop, и впишите ту же модель.\n\n${DEVICE_NOTE}`,
  }),
  'telegram.desktop.systemVersion': string({
    group: 'telegram', label: 'Desktop: версия ОС', default: TDESKTOP.systemVersion, required: true, effect: 'new_connections',
    description: 'Операционная система, которую видит Telegram, например «Windows 11 x64».',
    help: `Версия ОС, которую клиент сообщает Telegram: Telegram Desktop пишет «Windows 11» или «Windows 10» и разрядность системы — «Windows 11 x64». Видна в списке активных сеансов.\n\n${DEVICE_NOTE}`,
  }),
  'telegram.desktop.appVersion': string({
    group: 'telegram', label: 'Desktop: версия приложения', default: TDESKTOP.appVersion, required: true, effect: 'new_connections',
    description: 'Версия Telegram Desktop, например «7.2.9 x64».',
    help: `Версия приложения, которую клиент сообщает Telegram: номер версии и « x64» у 64-битной сборки для Windows (в том числе portable). По умолчанию — последняя стабильная на момент обновления панели; при выходе новых версий Telegram Desktop её стоит поднимать.\n\n${DEVICE_NOTE}`,
  }),
  'telegram.desktop.langCode': string({
    group: 'telegram', label: 'Desktop: код языка', default: 'ru', pattern: /^[a-z]{2}$/, patternMessage: 'Две латинские буквы, например ru', effect: 'new_connections',
    description: 'Язык клиента — две латинские буквы, например ru.',
    help: `Код языка (ISO 639-1: ru, en, kk…), который клиент сообщает Telegram. Может влиять на язык служебных сообщений Telegram, в том числе сообщений с кодами.\n\n${DEVICE_NOTE}`,
  }),
  'telegram.own.apiId': int({
    group: 'telegram', label: 'Свой api_id', default: null, min: 1, required: true, effect: 'new_connections',
    description: 'Ваш api_id с my.telegram.org — для новых сессий через QR.',
    help: 'Идентификатор вашего собственного приложения Telegram. Получить: войдите на my.telegram.org → API development tools → создайте приложение.\n\nИспользуется при входе по QR и при последующих подключениях этих аккаунтов. Пока значение не задано, вход по QR недоступен.',
  }),
  'telegram.own.apiHash': secret({
    group: 'telegram', label: 'Свой api_hash', required: true, effect: 'new_connections',
    description: 'Секретный ключ в пару к своему api_id, оттуда же.',
    help: `Ключ вашего приложения с my.telegram.org (страница API development tools), парный к «Свой api_id».\n\n${SECRET_NOTE}`,
  }),
  'telegram.qrTimeout': duration({
    group: 'telegram', label: 'Таймаут входа по QR', default: '5m', min: '1m', max: '15m',
    description: 'Сколько ждать сканирования QR-кода и пароля 2FA.',
    help: 'Общее время на вход по QR: показ кода, сканирование в приложении Telegram и, если включена двухэтапная проверка, ввод пароля. Когда время выходит, попытка отменяется — начните вход заново.',
  }),

  // notifications
  'notify.enabled': bool({
    group: 'notifications', label: 'Уведомления включены', default: false,
    description: 'Главный выключатель отправки в Telegram-канал.',
    help: 'Включает дублирование новых кодов и предупреждений в ваш канал. Работает, только если заданы токен бота и ID канала, иначе страница покажет предупреждение.\n\nКакие события отправлять, выбирается в «О чём уведомлять».',
  }),
  'notify.botToken': secret({
    group: 'notifications', label: 'Токен бота',
    description: 'Токен бота от @BotFather; бот — администратор канала.',
    help: `Создайте бота у @BotFather (команда /newbot) и вставьте выданный токен вида 123456789:AA…. Затем добавьте бота в канал администратором с правом публиковать сообщения.\n\n${SECRET_NOTE}`,
  }),
  'notify.chatId': string({
    group: 'notifications', label: 'ID канала', default: null, pattern: /^-100\d+$/, patternMessage: 'ID канала начинается с -100, например -1001234567890',
    description: 'Полный ID канала для Bot API — начинается с -100.',
    help: 'Куда бот отправляет уведомления. Bot API принимает ID канала только в полном виде: -100 и номер канала, например -1001234567890.\n\nВ web.telegram.org/k адрес открытого канала выглядит как #-1234567890 — это номер без префикса: допишите 100 после минуса. Если ID в адресе уже начинается с -100, берите его как есть.',
  }),
  'notify.events': multiselect({
    group: 'notifications', label: 'О чём уведомлять', options: notifyEventOptions, default: ['code', 'proxy_down', 'unauthorized', 'banned', 'frozen', 'proxy_expiring'],
    description: 'Какие события отправлять в канал.',
    help: '«Новый код» — каждое сообщение с кодом из чата @VerificationCodes (коды сторонних сервисов через Telegram).\n\nОстальные пункты — предупреждения о состоянии: аккаунт остановлен из-за недоступного прокси, сессия отозвана, бан, заморозка, скорое окончание оплаченного прокси.',
  }),
  'notify.maxAge': duration({
    group: 'notifications', label: 'Не слать коды старше', default: '10m', min: '1m', max: '1d',
    description: 'Старые коды при догрузке истории в канал не отправляются.',
    help: 'После простоя (перезапуск, потеря связи) пропущенные сообщения догружаются. Коды старше этого порога сохраняются в панели, но в канал не уходят: они уже бесполезны и только засорят канал.',
  }),

  // proxy
  'proxy.checkInterval': duration({
    group: 'proxy', label: 'Интервал проверки', default: '5m', min: '1m', max: '1d',
    description: 'Как часто проверять каждый прокси.',
    help: 'Проверка — соединение через прокси до сервера Telegram с замером задержки. Кроме расписания, прокси проверяется сразу после добавления и когда клиент аккаунта теряет связь. После неудачной проверки перепроверки идут чаще.',
  }),
  'proxy.failThreshold': int({
    group: 'proxy', label: 'Неудач подряд до «dead»', default: 3, min: 1, max: 20, unit: units.checks,
    description: 'Сколько неудачных проверок подряд — и прокси признаётся мёртвым.',
    help: 'Первая неудача переводит прокси в «failing», и проверки учащаются. Когда неудач подряд набирается столько, прокси получает статус «dead», а привязанный аккаунт останавливается: напрямую, без прокси, он сам не подключится.\n\nКак только проверка пройдёт успешно, аккаунт возобновится автоматически.',
  }),
  'proxy.expiryWarnDays': int({
    group: 'proxy', label: 'Предупреждать об истечении за', default: 3, min: 0, max: 30, unit: units.days,
    description: 'За сколько дней до окончания оплаты прокси предупредить в канале.',
    help: 'Для прокси с известной датой окончания (например, из proxy-store) в канал придёт предупреждение со списком таких прокси и привязанных к ним аккаунтов — чтобы успеть продлить.',
  }),

  // proxyStore
  'proxyStore.enabled': bool({
    group: 'proxyStore', label: 'Синхронизация включена', default: false,
    description: 'Автоматически подтягивать ваши прокси из proxy-store.com.',
    help: 'Панель периодически запрашивает список ваших прокси в proxy-store и обновляет пул: добавляет новые, обновляет изменённые, а пропавшие и истёкшие помечает «expired».\n\nПрокси, добавленные вручную, синхронизация не трогает. Без API-ключа не работает.',
  }),
  'proxyStore.apiKey': secret({
    group: 'proxyStore', label: 'API-ключ',
    description: 'Ключ API из личного кабинета proxy-store.',
    help: `Ключ входит в адрес API: https://proxy-store.com/api/{ключ}/getproxy/. Найти его можно в личном кабинете proxy-store.\n\n${SECRET_NOTE}`,
  }),
  'proxyStore.country': string({
    group: 'proxyStore', label: 'Страна', default: 'kz', pattern: /^[a-z]{2}$/, patternMessage: 'Код страны из двух букв',
    description: 'Брать только прокси этой страны — код из двух букв.',
    help: 'Фильтр по полю country в ответе proxy-store, например kz или de. Прокси других стран в пул не попадут.',
  }),
  'proxyStore.category': string({
    group: 'proxyStore', label: 'Категория', default: 'for_all', maxLength: 64,
    description: 'Брать только прокси этой категории.',
    help: 'Фильтр по полю category в ответе proxy-store — значение указывается так же, как в ответе API, по умолчанию for_all. Прокси других категорий в пул не попадут.',
  }),
  'proxyStore.syncInterval': duration({
    group: 'proxyStore', label: 'Интервал синхронизации', default: '15m', min: '1m', max: '1d',
    description: 'Как часто запрашивать список прокси у proxy-store.',
    help: 'Синхронизацию также можно запустить вручную на странице «Прокси».',
  }),

  // worker
  'worker.connectConcurrency': int({
    group: 'worker', label: 'Параллельных подключений', default: 5, min: 1, max: 50, unit: units.connections, effect: 'new_connections',
    description: 'Сколько аккаунтов подключать одновременно при запуске.',
    help: 'При старте аккаунты подключаются порциями этого размера с небольшой случайной паузой. Меньше — мягче к сети и прокси, больше — быстрее запуск. Для нескольких десятков аккаунтов 5 — разумное значение.',
  }),
  'worker.profileRefreshInterval': duration({
    group: 'worker', label: 'Обновлять профиль раз в', default: '6h', min: '10m', max: '7d',
    description: 'Как часто обновлять телефон, username, имя и Premium.',
    help: 'Профиль аккаунта запрашивается при каждом подключении и затем периодически с этим интервалом, чтобы в панели были актуальные телефон, username, имя и статус Premium.',
  }),

  // import
  'import.maxZipSizeMb': int({
    group: 'import', label: 'Максимальный размер zip', default: 50, min: 1, max: 1024, unit: units.megabytes,
    description: 'Архивы больше этого размера отклоняются сразу.',
    help: 'Проверяется до распаковки. Если архив с tdata не проходит, посмотрите, не попал ли в него кэш (например, папка user_data): для входа он не нужен.',
  }),
  'import.maxFiles': int({
    group: 'import', label: 'Максимум файлов в архиве', default: 5000, min: 1, max: 100_000, unit: units.files,
    description: 'Защита от архивов с огромным числом файлов.',
    help: 'Если файлов в архиве больше, импорт прерывается. Вместе с ограничениями размера защищает сервер от «zip-бомб».',
  }),
  'import.maxUnpackedSizeMb': int({
    group: 'import', label: 'Максимум после распаковки', default: 500, min: 1, max: 10_240, unit: units.megabytes,
    description: 'Ограничение суммарного размера файлов после распаковки.',
    help: 'Небольшой архив может распаковываться в гигабайты. Как только суммарный размер файлов превысит порог, импорт прерывается.',
  }),
  'import.draftTtl': duration({
    group: 'import', label: 'Хранить неподтверждённый импорт', default: '1h', min: '5m', max: '1d',
    description: 'Сколько загруженный импорт ждёт подтверждения.',
    help: 'После загрузки архива найденные аккаунты ждут подтверждения на экране предпросмотра. Если не подтвердить импорт за это время, он удаляется вместе с извлечёнными ключами — архив нужно будет загрузить снова.',
  }),

  // retention
  'retention.codeMessagesDays': int({
    group: 'retention', label: 'Хранить коды', default: 30, min: 1, max: 3650, unit: units.days,
    description: 'Сколько хранить полученные коды в панели.',
    help: 'Сообщения с кодами старше этого срока удаляются автоматически. Уже отправленные в канал уведомления это не затрагивает.',
  }),

  // security
  'security.sessionTtl': duration({
    group: 'security', label: 'Срок сессии админа', default: '7d', min: '10m', max: '90d',
    description: 'Сколько действует вход админа в панель.',
    help: 'После входа сессия действует указанный срок, затем нужно войти снова. Новое значение применяется к новым входам: уже открытые сессии доживают со старым сроком.',
  }),
  'security.loginMaxAttempts': int({
    group: 'security', label: 'Попыток входа в окне', default: 10, min: 3, max: 100, unit: units.attempts,
    description: 'Сколько неудачных попыток входа разрешено за окно.',
    help: 'Считаются только неудачные попытки — отдельно для каждого IP и для каждого логина. Когда лимит исчерпан, вход блокируется до конца окна. Успешный вход сбрасывает счётчик логина.',
  }),
  'security.loginWindow': duration({
    group: 'security', label: 'Окно ограничения попыток', default: '15m', min: '1m', max: '1d',
    description: 'За какой период считаются неудачные попытки входа.',
    help: 'Окно начинается с первой неудачной попытки; когда оно заканчивается, счётчик обнуляется.',
  }),
} as const satisfies Record<string, SettingDef<unknown, unknown>>

export type SettingKey = keyof typeof settingsDef
export type SettingsValues = { [K in SettingKey]: SettingValueOf<(typeof settingsDef)[K]> }
export type NotifyEvent = (typeof notifyEventOptions)[number]['value']
