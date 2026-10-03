# accs-manager — дизайн

- **Дата:** 2026-10-03
- **Статус:** утверждён в обсуждении, ожидает ревью спеки
- **Репозиторий:** `github.com/nokimaro/accs-manager` (публичный)

## 1. Цель

Веб-панель для управления пулом собственных Telegram-аккаунтов (50+) и сбора в одном
месте кодов авторизации, которые Telegram присылает в служебный чат `777000` каждого
аккаунта. Новые коды дополнительно дублируются в приватный Telegram-канал.

### Критерии успеха

- Аккаунт добавляется из zip-архива с tdata (структура архива произвольная) или
  новой сессией через QR-код; после добавления он проверен и виден в списке со статусом.
- Новый код из любого аккаунта появляется в ленте панели и в канале за секунды.
- Коды, пришедшие во время простоя воркера, не теряются.
- Ни один аккаунт не подключается к Telegram с IP сервера без явного разрешения.
- Падение прокси не роняет аккаунт молча: сессия ставится на паузу, приходит предупреждение.
- Все действия админов записаны в аудит.
- Утечка дампа БД не даёт доступа к аккаунтам.
- Любая настройка, кроме инфраструктурных, меняется из админки и применяется без
  перезапуска; `.env` содержит только инфраструктуру.

### Вне объёма v1

- Деплой-воркфлоу (GHCR + ssh) — отдельная задача; в v1 только CI.
- TLS / reverse proxy — внешний, на стороне сервера.
- Роли и разграничение доступа — все админы равны.
- Шардирование воркеров (сотни аккаунтов) — архитектура B допускает рост, но не реализуется.
- Любые действия от имени аккаунтов, кроме чтения `777000`, профиля и управления сессиями.

## 2. Принятые решения

| Вопрос | Решение | Почему |
|---|---|---|
| Библиотека Telegram | **mtcute 0.32.x** (`@mtcute/node`, `@mtcute/convert`, `@mtcute/postgres`) | Единственная живая TS-библиотека MTProto с нативным чтением tdata. GramJS заархивирован (07.2026). Python-альтернативы (opentele, TGConvertor) — второй язык. |
| Судьба tdata | Используется **только для переноса**: из неё извлекается auth key, сама tdata не хранится. Десктоп с перенесённой tdata больше не запускается. | Решение владельца. Одновременное использование ключа с разных IP → `AUTH_KEY_DUPLICATED`. |
| Новые сессии | Опционально — вход по **QR-коду** (+ 2FA-пароль) | Сценарий «у меня есть активная сессия, авторизую сервер как новую». |
| Профиль клиента | tdata-аккаунты — профиль Telegram Desktop (его api_id + параметры устройства); QR-аккаунты — собственный api_id с my.telegram.org. Значения — в настройках (§9). | Импортированная сессия не «превращается» резко в другое приложение. |
| Архитектура | **B: `api` и `worker` раздельно**, Redis (BullMQ + pub/sub), один экземпляр воркера | 50+ постоянных MTProto-соединений; рестарт API не рвёт соединения. |
| Прокси | Пул прокси; у аккаунта опциональный (рекомендуемый) прокси; SOCKS5 предпочтителен, HTTP поддерживается | Масштаб 50+ с одного IP; см. §6. |
| Уведомления | Bot API `sendMessage` в приватный канал | Пожелание владельца; полноценный бот не нужен. |
| Панель | Несколько админов, все равны; логин/пароль; глобальный аудит; первый админ — через CLI | Пожелание владельца. |
| Настройки | **Типизированные настройки в БД**, определения — в коде (zod 4-схемы + метаданные); раздел в админке строится из тех же определений; применение без перезапуска. Собственная реализация. | `.env` разрастается, а смена любого параметра требовала рестарта. Готовые генераторы форм (`@rjsf/shadcn` — на Radix, AutoForm — устаревший shadcn-адаптер) не ложатся на Base UI и нужды раздела. |
| Фронтенд | React + Vite SPA, TanStack Router/Query, **только shadcn/ui (Base UI)** | Пожелание владельца. |
| Стек | Node 26 (`node:26-trixie-slim`), PostgreSQL 18, Redis 8, pnpm 12, Hono, Drizzle, Zod 4 | Последние стабильные версии на 2026-10-03; Debian вместо alpine — выбор владельца. |

### Результаты спайков (2026-10-03)

- `@mtcute/convert` прочитал реальный архив владельца: корень tdata лежал в подпапке
  `tdata/`, 1 аккаунт, DC2, auth key 256 байт. Сеть не использовалась.
- Версия формата в файлах архива — `3004000` (TDesktop 3.4.0): архив, по-видимому,
  собран конвертером/очищен (всего 3 файла). mtcute без флага принимает версии до
  `5008003`; для tdata от TDesktop 7.x импортёр **всегда** передаёт `ignoreVersion: true`.
- Тот же спайк проходит в `node:24-alpine` и в `node:26-trixie-slim` (Node 26.10.0):
  `TelegramClient` + `SocksProxyTcpTransport` создаются, `crypto.argon2` (argon2id) работает.
  `better-sqlite3` подгружается лениво и не нужен — нативных модулей в стеке нет.
- proxy-store API: ответ `{status, list: {<id>: {...}}}`; только что купленные прокси
  отдаются с `ip: 0.0.0.0`, `port: 0`, пустыми логином и паролем — до выдачи провайдером.

## 3. Архитектура

```
        браузер (React SPA)
           │  HTTPS (внешний reverse proxy)
           ▼
   ┌──────────────┐  BullMQ: worker-commands   ┌──────────────────┐
   │     api      │ ─────────────────────────► │      worker      │──► Telegram (MTProto)
   │ Hono + SPA   │ ◄───────────────────────── │ mtcute × N       │      через прокси
   │ auth, audit, │  Redis pub/sub: события,   │ proxy checker    │──► proxy-store API
   │ settings,SSE │  settings.changed          │ notifier         │──► Bot API → канал
   └──────┬───────┘                            └────────┬─────────┘
          │                PostgreSQL 18                │
          └──────────────────────┬──────────────────────┘
                                 ▼
                          Redis 8 (очереди, pub/sub, rate limit, QR-состояние)
```

- **api** никогда не открывает MTProto-соединений. Разбирает zip с tdata (это чистая
  работа с файлами), всё сетевое к Telegram — через команды воркеру.
- **worker** — единственный владелец всех клиентов Telegram. Запускается в **одном
  экземпляре**: при старте берёт `pg_advisory_lock`; второй экземпляр ждёт. Деплой воркера —
  stop-first. Это защищает от `AUTH_KEY_DUPLICATED` при перекрытии старого и нового процесса.
- Оба процесса держат кеш настроек и перечитывают его по событию `settings.changed` (§9).

### Структура монорепо (pnpm workspaces)

```
apps/
  web/        React + Vite SPA (каркас — shadcn init --template vite --monorepo)
  api/        Hono: REST + SSE + раздача статики web + CLI (admin:*, settings:*)
  worker/     клиенты mtcute, проверка/синхронизация прокси, уведомления, cron-задачи
packages/
  ui/         компоненты shadcn (создаётся shadcn CLI)
  db/         схема Drizzle, миграции, клиент
  shared/     без IO (импортируется и вебом): zod-схемы, контракты API и событий,
              env-схема, crypto (только сервер), settings/ (определения, типы, валидация)
  server/     серверные сервисы для api и worker: логгер, Redis, шина событий,
              SettingsService, запись аудита
```

## 4. Модель данных (PostgreSQL, Drizzle)

| Таблица | Поля (ключевые) |
|---|---|
| `admins` | `id`, `login` (unique), `password_hash` (argon2id), `disabled_at`, `last_login_at`, `created_at` |
| `admin_sessions` | `id`, `token_hash`, `admin_id`, `expires_at`, `ip`, `user_agent`, `created_at` |
| `audit_log` | `id`, `actor_type` (`admin`/`system`/`cli`), `admin_id?`, `action`, `target_type?`, `target_id?`, `payload` jsonb (очищен от секретов), `ip?`, `user_agent?`, `status_code?`, `result` (`ok`/`error`), `duration_ms?`, `created_at` |
| `settings` | `key` (PK), `value` jsonb (для секретов — `{enc: "v1:…"}`), `updated_at`, `updated_by?`. Хранятся только значения, отличные от умолчаний |
| `accounts` | `id`, `tg_user_id` (unique), `phone`, `username`, `first_name`, `last_name`, `is_premium`, `dc_id`, `label`, `note`, `source` (`tdata`/`qr`), `client_profile` (`desktop`/`own`), `device` jsonb (model, system, app version, lang — фиксируются при добавлении), `connection_mode` (`proxy`/`direct`), `proxy_id?` (FK, unique), `status`, `status_reason`, `status_changed_at`, `last_ok_at`, `created_at`, `updated_at` |
| `account_auth` | `account_id` (PK/FK), `dc_id`, `auth_key_enc` |
| `proxies` | `id`, `source` (`manual`/`proxy_store`), `external_id?`, `type` (`socks5`/`http`), `host`, `port`, `username?`, `password_enc?`, `tag?`, `status`, `last_check_at`, `last_ok_at`, `latency_ms`, `last_error`, `fail_streak`, `expires_at?`, `provider_meta` jsonb, `disabled_at?`, `created_at`, `updated_at`. Unique: (`type`,`host`,`port`,`username`); unique (`source`,`external_id`) |
| `code_messages` | `id`, `account_id`, `tg_message_id`, `date`, `text`, `code?`, `notified_at?`, `created_at`. Unique (`account_id`,`tg_message_id`) |
| `import_batches` | `id`, `admin_id`, `filename`, `status`, `created_at`, `expires_at` |
| `import_items` | `id`, `batch_id`, `path_in_archive`, `account_index`, `tg_user_id`, `dc_id`, `auth_key_enc`, `duplicate_of?`, `decision` (`pending`/`imported`/`skipped`), `error?` |

Плюс служебные таблицы `@mtcute/postgres` (кеш пиров, состояние апдейтов), разделённые
по `account: <accounts.id>`.

**Не в Postgres:** состояние активного QR-входа (Redis, TTL); список активных сессий
аккаунта (запрашивается у Telegram на лету через `account.getAuthorizations`).

**Удержание:** `code_messages` старше `retention.codeMessagesDays` удаляются cron-задачей;
неподтверждённые `import_*` удаляются по `expires_at` (`import.draftTtl`).

### Шифрование

- AES-256-GCM, мастер-ключ `APP_ENCRYPTION_KEY` (32 байта, base64) — **только в `.env`**:
  им шифруются секреты в самой БД, поэтому хранить его в БД нельзя.
- Формат шифротекста: `v1:<iv>:<ciphertext>:<tag>` (base64) — префикс версии ключа
  для будущей ротации.
- Шифруются: `account_auth.auth_key_enc`, `import_items.auth_key_enc`,
  `proxies.password_enc`, значения настроек типа `secret`.
- `@mtcute/postgres` хранит auth key открытым текстом. Требование: ключ в его таблицах
  **не хранится в открытом виде**. Способ (подмена репозитория auth keys в хранилище mtcute
  на шифрующую обёртку над `account_auth`, либо собственный storage-провайдер) выбирается
  и проверяется на этапе плана.

## 5. Воркер и жизненный цикл аккаунта

### Старт и остановка

- Захват `pg_advisory_lock` → загрузка настроек → загрузка аккаунтов в рабочих статусах →
  подъём клиентов порциями по `worker.connectConcurrency` с джиттером.
- SIGTERM: прекратить приём задач → `destroy()` всех клиентов → отпустить lock.
  `stop_grace_period: 30s`.

### Клиент аккаунта

`TelegramClient` с: хранилищем в Postgres (шифрованный ключ), транспортом по
`connection_mode` и типу прокси (`SocksProxyTcpTransport` / `HttpProxyTcpTransport` /
прямой TCP), `apiId`/`apiHash` и параметрами устройства из профиля аккаунта
(`telegram.desktop.*` / `telegram.own.*`). Короткие `FLOOD_WAIT` mtcute переживает сам
(`floodSleepThreshold`), длинные — задача повторяется позже.

### Статусы аккаунта

```
pending_check ──проверка──► active ◄──────► paused            (вручную)
                              │  ▲
                прокси упал   ▼  │ прокси ожил / заменён / разрешён direct
                         proxy_down
active ──► unauthorized   AUTH_KEY_UNREGISTERED / SESSION_REVOKED / AUTH_KEY_DUPLICATED (конечный)
active ──► banned         USER_DEACTIVATED_BAN (конечный)
active ──► frozen         заморозка по appConfig; клиент остаётся онлайн, коды принимаются
active ──► error          неожиданная ошибка → повтор с экспоненциальной задержкой
```

Каждый переход: запись в `accounts` + `audit_log` (`actor_type=system`) + событие
`account.status` в pub/sub. Переходы в `unauthorized`, `banned`, `frozen`, `proxy_down` —
дополнительно предупреждение в канал (если тип события включён в `notify.events`).
Клиент **никогда** не переключается на прямое подключение сам.

### Коды

1. Новое входящее сообщение от `777000` → извлечение кода: первое отдельно стоящее
   число из 5–6 цифр, иначе `null` (полный текст сохраняется всегда).
2. Upsert в `code_messages` → событие `code.new` → задача `notify` (BullMQ, ретраи с backoff)
   → Bot API `sendMessage` в `notify.chatId` → `notified_at`.
3. При каждом (пере)подключении — догрузка истории `777000` начиная с последнего
   сохранённого `tg_message_id` (идемпотентно за счёт unique-ключа). Уведомления при
   догрузке — только для сообщений моложе `notify.maxAge`.

Формат уведомления: метка (или телефон) аккаунта, код, время, полный текст.
Уведомления не отправляются, если `notify.enabled = false` или не заданы
`notify.botToken` / `notify.chatId`.

### Профиль

`getMe` при подключении и раз в `worker.profileRefreshInterval` → телефон, username,
имя, Premium.

### Команды от API (очередь `worker-commands`)

`import.confirm`, `qr.start`, `qr.password`, `qr.cancel`, `account.pause`, `account.resume`,
`account.check`, `account.delete` (с `auth.logOut` или без), `account.setProxy`
(прокси / `direct`), `sessions.list`, `sessions.terminate`, `proxy.check`, `proxy.sync`.
Где нужен ответ (`sessions.list`) — API ждёт результата задачи с таймаутом.

## 6. Прокси

### Источники (равноправные)

1. **Вручную по одному** — форма: тип, host, порт, логин, пароль, метка.
2. **Импорт списка** — текст или `.txt`, по строке; форматы `socks5://user:pass@host:port`,
   `http://…`, `host:port`, `host:port:user:pass`, `user:pass@host:port`; тип по умолчанию
   выбирается при импорте. Предпросмотр: разобрано / ошибки / дубли.
3. **Автосинхронизация с proxy-store** (`source=proxy_store`).

### Синхронизация с proxy-store

- Включается `proxyStore.enabled`; без `proxyStore.apiKey` (секретная настройка)
  не работает, и UI это показывает.
- `GET https://proxy-store.com/api/{proxyStore.apiKey}/getproxy/` раз в
  `proxyStore.syncInterval` и по кнопке.
- Фильтр: `country = proxyStore.country` (`kz`), `category = proxyStore.category`
  (`for_all`), `active = "1"`.
- Маппинг типа: `socks` → `socks5`, `http` → `http`. `date_end` → `expires_at`;
  `order_id`, `autoprolong` → `provider_meta`.
- `ip = 0.0.0.0` или `port = 0` → статус `provisioning`, в пул и проверки не попадает.
- Новые → `unchecked` → проверка. Изменились ip/порт/логин/пароль → обновить,
  перепроверить, переподключить привязанный аккаунт.
- Пропал из ответа или истёк → `expired`; привязанный аккаунт → `proxy_down` + предупреждение.
- Синхронизация **никогда** не трогает записи с `source=manual`.

### Проверка здоровья (для всех источников)

- SOCKS5-рукопожатие / HTTP `CONNECT` до адреса Telegram DC, замер задержки.
- По расписанию (`proxy.checkInterval`), сразу после добавления и внепланово при потере
  соединения клиентом.
- 1 неудача → `failing` (учащённые перепроверки); `proxy.failThreshold` подряд → `dead` →
  привязанный аккаунт `proxy_down`. Успешная проверка → `ok` → аккаунт в `proxy_down`
  возобновляется автоматически.
- Статусы: `provisioning` → `unchecked` → `ok` / `failing` / `dead` / `expired`.
- За `proxy.expiryWarnDays` до `expires_at` — предупреждение в канал со списком
  прокси и привязанных аккаунтов.

### Привязка

- «Доступный» прокси: `status = ok`, не отключён, не привязан. Один прокси — не более
  одного аккаунта (unique `accounts.proxy_id`).
- Назначение: при импорте tdata (по строке или «Раздать автоматически»), при QR-входе,
  в карточке аккаунта. `direct` — только явным выбором админа.

## 7. Добавление аккаунтов

### Импорт tdata (zip)

1. **Загрузка и разбор (api, без сети):**
   - zip распаковывается во временную директорию с защитой от zip-slip, симлинков и
     zip-бомб (`import.maxZipSizeMb`, `import.maxFiles`, `import.maxUnpackedSizeMb`);
   - корни tdata ищутся рекурсивно по файлу `key_<dataKey>s` (по умолчанию `key_datas`)
     на любой глубине; в архиве может быть несколько корней, в корне — несколько
     аккаунтов (по `key_datas`: count/order);
   - `Tdata.open({ path, passcode, ignoreVersion: true })`; при ошибке расшифровки
     `key_datas` — запрос локального код-пароля;
   - для каждого аккаунта — `readMtpAuthorization` → `tg_user_id`, `dc_id`, auth key
     (сразу шифруется) → `import_items`; признак дубля, если `tg_user_id` уже в `accounts`;
   - временная директория удаляется **всегда** (`finally`).
2. **Предпросмотр и подтверждение:** список найденных аккаунтов (user id, DC, путь
   в архиве, дубль) → админ назначает каждому прокси / `direct` / пропуск → `import.confirm`.
3. **Проверка (worker):** первое подключение уже через назначенный прокси → `getMe`,
   профиль, статус → `accounts` + `account_auth`.

### Вход по QR

1. Админ выбирает прокси (или `direct`) → `qr.start` → воркер поднимает временный
   клиент (`client_profile=own`) и публикует обновления QR-ссылки в `qr:{id}` → API → SSE
   → браузер рисует QR.
2. Требуется 2FA → событие `password_needed` (с подсказкой) → админ вводит пароль →
   `qr.password`. Пароль не сохраняется, не логируется, в аудите — `[redacted]`.
3. Успех → аккаунт `active`, ключ шифруется в `account_auth`. Общий таймаут —
   `telegram.qrTimeout`.

## 8. API (Hono)

Все входные данные — через zod-схемы из `packages/shared`. Префикс `/api`.

| Группа | Эндпоинты |
|---|---|
| Авторизация | `POST /auth/login`, `POST /auth/logout`, `GET /auth/me`, `POST /auth/password` |
| Админы | `GET/POST /admins`, `POST /admins/:id/disable`, `POST /admins/:id/reset-password` (последнего активного отключить нельзя) |
| Аккаунты | `GET /accounts`, `GET/PATCH/DELETE /accounts/:id` (`?logout=true`), `POST /accounts/:id/{pause,resume,check}`, `PUT /accounts/:id/proxy`, `GET /accounts/:id/sessions`, `DELETE /accounts/:id/sessions/:hash`, `GET /accounts/:id/messages` |
| Импорт | `POST /imports` (multipart), `GET /imports/:id`, `POST /imports/:id/confirm` |
| QR | `POST /qr-logins`, `GET /qr-logins/:id/events` (SSE), `POST /qr-logins/:id/password`, `DELETE /qr-logins/:id` |
| Прокси | `GET/POST /proxies`, `POST /proxies/import` (`?dryRun`), `PATCH/DELETE /proxies/:id`, `POST /proxies/:id/check`, `POST /proxies/sync` |
| Коды | `GET /messages` (пагинация, фильтр по аккаунту) |
| Настройки | `GET /settings`, `PATCH /settings` (§9) |
| Аудит | `GET /audit` (фильтры: админ, действие, период) |
| События | `GET /events` (SSE: `code.new`, `account.status`, `proxy.status`, `import.progress`, `settings.changed`) |
| Служебное | `GET /healthz` |

### Безопасность

- Пароли — argon2id (`node:crypto`). Сессия — случайный токен в cookie
  `httpOnly; Secure; SameSite=Strict`, в БД только хеш. Срок — `security.sessionTtl`.
- CSRF: для изменяющих запросов проверяется `Origin` против `PUBLIC_ORIGIN`.
- Rate limit на `/auth/login` в Redis по IP и по логину: считаются только **неудачные**
  попытки (`security.loginMaxAttempts` за `security.loginWindow`); успешный вход не
  блокирует и сбрасывает счётчик логина.
- `TRUST_PROXY` — доверять `X-Forwarded-For` от внешнего reverse proxy: IP клиента — крайний правый адрес
  заголовка (его дописал наш proxy; левые адреса задаёт клиент).

### Аудит

Глобальный middleware пишет в `audit_log`:

- все `POST/PUT/PATCH/DELETE`;
- вход/выход, включая неудачные попытки;
- чувствительные чтения (`GET /accounts/:id/sessions`).

Поля: актор, `action` (из метаданных роута, например `account.update`, `proxy.import`,
`settings.update`), `target` из параметров, IP, user-agent, HTTP-статус, длительность,
тело запроса после санитайзера (`password`, `passcode`, ключи, пароли прокси, значения
секретных настроек, содержимое файлов → `[redacted]`). Запись выполняется и при ошибке
обработчика.

### CLI

- `admin:create --login <login>`, `admin:reset-password --login <login>`,
  `admin:disable --login <login>` — пароль интерактивно или `--password-stdin`.
- `settings:get [<key>]`, `settings:set <key> <value>`, `settings:reset <key>` — для
  первичной настройки сервера без UI; секрет — через `--value-stdin`.
- В контейнере: `docker compose exec accs-api node apps/api/src/cli.ts <команда>` (сборки нет).
- Действия CLI — в аудит с `actor_type=cli`.

## 9. Настройки

### Принцип

Определения настроек живут в коде (`packages/shared/settings`), значения — в таблице
`settings`, мастер-копия умолчаний — в коде. В `.env` — только инфраструктура (§11).

### Определение

Каждая настройка — zod 4-схема + типизированные метаданные в одном объекте определения.
Хелперы по типам строят схему с ограничениями из определения:

```ts
export const settingsDef = {
  'notify.botToken': secret({ group: 'notifications', label: 'Токен бота',
    description: 'Бот должен быть админом канала', effect: 'immediate' }),
  'notify.events': multiselect({ group: 'notifications', label: 'О чём уведомлять',
    options: [...], default: [...] }),
  'proxy.checkInterval': duration({ group: 'proxy', label: 'Интервал проверки',
    default: '5m', min: '1m' }),
  'worker.connectConcurrency': int({ group: 'worker', label: 'Параллельных подключений',
    default: 5, min: 1, max: 50, effect: 'new_connections' }),
} as const

// тип значения выводится из определения
type Settings = { [K in keyof typeof settingsDef]: z.output<(typeof settingsDef)[K]['schema']> }
settings.get('worker.connectConcurrency') // number
```

| Тип | Значение | Контрол в UI |
|---|---|---|
| `string` | строка (опц. `pattern`, `maxLength`) | `Input` |
| `text` | многострочная строка | `Textarea` |
| `int` | целое, `min`/`max`/`step` | `Input type=number` |
| `decimal` | десятичное (строка в JSON, без потери точности), `min`/`max`/`scale` | `Input type=number` |
| `bool` | true/false | `Switch` |
| `select` | одно из `options` | `Select` |
| `multiselect` | подмножество `options` | `FieldSet` + `Checkbox` |
| `duration` | строка вида `5m`, `6h`, `7d`; `min`/`max` | `InputGroup` с единицей |
| `secret` | строка, хранится зашифрованной, в API не возвращается | `InputGroup`: «задан / не задан», «Заменить», «Очистить» |

Метаданные: `group`, `label`, `description`, `default`, `effect`
(`immediate` / `new_connections` / `restart`), `order`, `required`. Группы (название, описание,
порядок) — тоже в коде. SPA импортирует определения напрямую из `@workspace/shared/settings`
и валидирует теми же схемами, что и сервер; API отдаёт только значения.
Новый тип = один хелпер + один `case` в UI-компоненте `SettingField`.

### Набор настроек v1

| Группа | Ключи (умолчание) |
|---|---|
| `telegram` | `telegram.desktop.apiId`, `telegram.desktop.apiHash` (secret), `telegram.desktop.deviceModel`, `telegram.desktop.systemVersion`, `telegram.desktop.appVersion`, `telegram.desktop.langCode`, `telegram.own.apiId`, `telegram.own.apiHash` (secret), `telegram.qrTimeout` (`5m`) — effect `new_connections` |
| `notifications` | `notify.enabled` (`false`), `notify.botToken` (secret), `notify.chatId`, `notify.events` (`code`, `proxy_down`, `unauthorized`, `banned`, `frozen`, `proxy_expiring`), `notify.maxAge` (`10m`) |
| `proxy` | `proxy.checkInterval` (`5m`), `proxy.failThreshold` (`3`), `proxy.expiryWarnDays` (`3`) |
| `proxyStore` | `proxyStore.enabled` (`false`), `proxyStore.apiKey` (secret), `proxyStore.country` (`kz`), `proxyStore.category` (`for_all`), `proxyStore.syncInterval` (`15m`) |
| `worker` | `worker.connectConcurrency` (`5`), `worker.profileRefreshInterval` (`6h`) |
| `import` | `import.maxZipSizeMb` (`50`), `import.maxFiles` (`5000`), `import.maxUnpackedSizeMb` (`500`), `import.draftTtl` (`1h`) |
| `retention` | `retention.codeMessagesDays` (`30`) |
| `security` | `security.sessionTtl` (`7d`), `security.loginMaxAttempts` (`10`), `security.loginWindow` (`15m`) |

### Хранение и чтение

- В `settings` — только переопределённые значения; отсутствие строки = умолчание из кода.
- Секреты — `{enc: "v1:…"}` (AES-256-GCM, §4).
- Сохранённое значение, не прошедшее валидацию (например, после смены типа в коде), →
  используется умолчание, в лог — предупреждение. Ключи, которых нет в коде, игнорируются.
- Пустые обязательные значения не роняют процесс, а отключают функцию (нет токена бота →
  нет уведомлений; нет ключа proxy-store → нет синхронизации); UI показывает `Alert`.

### Применение без перезапуска

- `SettingsService` в api и worker: кеш всех значений, `get(key)` (типизирован),
  `onChange(key, cb)`.
- `PATCH /settings` → валидация всех изменений → запись одной транзакцией → публикация
  `settings.changed {keys}` в Redis → оба процесса перечитывают кеш → подписчики
  реагируют (переставить repeatable-задачи при смене интервалов, применить новый токен
  к следующей отправке, новые api_id — к новым подключениям).
- `effect` показывается в UI рядом с настройкой; `restart` — явное предупреждение.
- Конкурентные правки: last-write-wins; открытая страница настроек получает
  `settings.changed` по SSE, обновляет значения и показывает `toast`, если изменения
  внёс другой админ.

### API

- `GET /settings` → текущие значения по ключам (`value`, `isSet`, `overridden`,
  `updatedAt`, `updatedBy`); у секретов `value` всегда `null`, есть только `isSet`.
- `PATCH /settings` ← `{ "changes": { "<key>": value | null } }` (`null` — сбросить к умолчанию);
  атомарно: либо все изменения, либо ни одного; ошибки валидации — по ключам.
- Аудит: `settings.update` с old/new значениями; секреты — `[redacted]`.

## 10. UI

**Правило:** весь UI строится из компонентов shadcn/ui (Base UI) по правилам скилла
`shadcn` (`.claude/skills/shadcn`): семантические токены цвета, `FieldGroup`/`Field` для
форм, `gap-*` вместо `space-*`, `Badge`/`Empty`/`Skeleton`/`Alert`/`toast` вместо
кастомной разметки. Отсутствующий элемент — сначала `shadcn search`; сторонние реестры —
только с явного согласия владельца проекта.

### Навигация

- **Desktop:** верхний navbar, без sidebar. Слева — название; табы
  **Коды · Аккаунты · Прокси · Аудит · Админы · Настройки** — `Tabs` + `TabsList variant="line"`
  в `<nav>`, триггеры — ссылки TanStack Router (`render`, `nativeButton={false}`), активный по
  текущему маршруту.
  Справа — индикатор SSE-соединения и `DropdownMenu` админа (`Avatar` + `AvatarFallback`):
  сменить пароль, выйти.
- **Mobile (< md):** бургер (`Button`) → `Sheet` слева (с `SheetTitle`) с теми же табами
  `orientation="vertical"`.

### Страницы

| Страница | Содержимое и компоненты |
|---|---|
| Вход | `Card` + `FieldGroup`, `InputGroup` для пароля |
| Коды (главная) | Живая лента всех аккаунтов: аккаунт, крупный код + копирование (`Button` + `toast`), относительное время (`Tooltip` с точным), раскрывающийся текст; подсветка новых; фильтр по аккаунту (`Combobox`) |
| Аккаунты | Data Table (`Table` + TanStack Table, `Pagination`): метка, телефон, username, статус (`Badge`), прокси + его статус, последнее подключение, меню действий (`DropdownMenu`). Фильтры: `Input`, `ToggleGroup` по статусам. Кнопка «Добавить» → `Dialog` + `Tabs`: **tdata** (`Field` + `Input type=file` с drag-n-drop, код-пароль → таблица предпросмотра с `Select` прокси и «Раздать автоматически») / **QR** (выбор прокси → `Card` с QR, `Spinner`, поле 2FA) |
| Карточка аккаунта | Профиль, метка/заметка, прокси и режим, активные сессии (`Table` + «Завершить» через `AlertDialog`), коды аккаунта, удаление с/без logout (`AlertDialog`) |
| Прокси | Data Table: статус, источник, тип, задержка, срок, привязанный аккаунт; фильтр по источнику/статусу; «Добавить» (`Dialog`), «Импорт списка» (`Dialog` + предпросмотр + `Alert` с ошибками), «Синхронизировать» |
| Аудит | Data Table с фильтрами (админ, действие, период) |
| Админы | Data Table; создать, отключить, сбросить пароль |
| Настройки | `Tabs` (line) по группам, на mobile — горизонтальная прокрутка. Группа — `Card` (`CardHeader` с названием и описанием группы) + `FieldGroup`; каждая настройка — `Field` (метка, `FieldDescription`, контрол по типу из §9, `Badge` «изменено» + «Сбросить», пометка `effect`). «Сохранить» в `CardFooter`, активна только при изменениях; ошибки валидации — `data-invalid` на `Field`. Незаполненные обязательные — `Alert` в шапке группы |

Пустые состояния — `Empty`, загрузка — `Skeleton`, ошибки — `Alert`. Тема — светлая/тёмная
по системной.

### Каркас

`shadcn init --template vite --monorepo --preset nova --base base` → `apps/web` + `packages/ui`;
тема — `blue` + базовый `mist` (`shadcn apply --only theme`).

## 11. Инфраструктура

### Docker

- Один multi-stage `Dockerfile`, база `node:26-trixie-slim`, pnpm 12 через corepack:
  `deps` → `build` → `pnpm deploy --prod` → runtime-образы `api` (со статикой web) и
  `worker`. Пользователь `node`, `--init`, healthcheck.
- **Правило:** без нативных зависимостей там, где есть чистый JS/WASM; при проблемах
  с образом — менять базу, а не архитектуру.
- `compose.yml` (все сервисы, контейнеры, тома и сеть — с префиксом `accs-`:
  `accs-postgres`, `accs-redis`, `accs-migrate`, `accs-api`, `accs-pgdata`, `accs-redisdata`, `accs-net`):
  - `postgres:18-trixie` — volume на `/var/lib/postgresql` (с v18 образ хранит `PGDATA`
    в версионированном подкаталоге);
  - `redis:8-trixie` — `appendonly yes`, `maxmemory-policy noeviction` (требование BullMQ);
  - `migrate` — одноразовый, миграции Drizzle; `api`/`worker` зависят от
    `service_completed_successfully`;
  - `api` — порт `3000`; `worker` — без портов, `stop_grace_period: 30s`;
  - Postgres и Redis наружу не публикуются.
- `compose.dev.yml` — порты Postgres/Redis для локальной разработки (настраиваемые:
  `DEV_PG_PORT`/`DEV_REDIS_PORT`); приложения в dev — `pnpm dev`, Vite проксирует `/api` на api.
- `api` и `worker` не собираются: Node 26 исполняет TypeScript напрямую (type stripping);
  workspace-пакеты подключаются симлинками pnpm. Собирается только `web` (Vite).

### `.env` — только инфраструктура

В репозитории — `.env.example`; `.env` — в `.gitignore`. Валидация zod при старте
каждого процесса (fail fast).

| Переменная | Назначение |
|---|---|
| `NODE_ENV` | `production` / `development` |
| `PORT` | порт api (по умолчанию `3000`) |
| `DATABASE_URL` | PostgreSQL |
| `REDIS_URL` | Redis |
| `APP_ENCRYPTION_KEY` | мастер-ключ AES-256-GCM (32 байта, base64) |
| `PUBLIC_ORIGIN` | внешний адрес панели (cookie, проверка `Origin`) |
| `TRUST_PROXY` | доверять `X-Forwarded-For` (IP клиента — крайний правый адрес) |
| `LOG_LEVEL` | уровень логов pino |

Всё остальное — настройки в БД (§9). Логи — pino (JSON) с redaction ключей, паролей, токенов.

### CI (GitHub Actions)

`ci.yml` с первого коммита: lint, typecheck, тесты (сервисы Postgres 18 и Redis 8),
сборка Docker-образов. Деплой (GHCR + ssh, stop-first для воркера) — отдельная задача.

### Гигиена репозитория

`.gitignore`: `.env`, `tdata-samples/`, `*.zip`, `.DS_Store`, `node_modules`, `dist`.
Скиллы проекта (`.agents/`, `.claude/skills/`, `skills-lock.json`) коммитятся.

## 12. Тестирование (Vitest)

- **Unit:** поиск tdata в zip (вложенность, несколько корней, zip-slip, лимиты);
  извлечение кода из текстов `777000` (RU/EN); парсер списков прокси; маппинг
  proxy-store (`provisioning`, `expired`, смена данных); шифрование (round-trip, подмена
  шифротекста); санитайзер аудита; переходы статусов аккаунта; настройки — хелперы типов
  (валидация границ, `duration`, `decimal`), выведение типов (`expectTypeOf`), фолбэк
  на умолчание при невалидном сохранённом значении, проекция в JSON Schema.
- Тестовые tdata **генерируются в тестах** через `convertToTdata` со случайными ключами;
  реальные ключи в репозиторий не попадают.
- **Интеграционные:** API на реальных Postgres/Redis — вход, rate limit, аудит, путь
  импорта, `PATCH /settings` (атомарность, секреты не возвращаются, `settings.changed`
  доходит до подписчика). Воркер работает через интерфейс `TelegramGateway`; в тестах —
  фейковая реализация, CI в Telegram не ходит.
- **E2E smoke (Playwright):** вход, переход по табам, мобильное меню в `Sheet`,
  сохранение настройки.
- **Реальный Telegram** — только ручные проверки и спайки.

## 13. Риски и открытые вопросы

| Риск | Что делаем |
|---|---|
| tdata, записанная самим TDesktop 7.x, не проверена (образец — v3.4.0) | `ignoreVersion: true`; прогнать спайк на «живой» tdata 7.x, как только появится. Запасной путь — Python-конвертер (opentele2/TGConvertor) как отдельная утилита. |
| Встраивание шифрования ключа в хранилище mtcute | Выбрать и проверить подход на этапе плана (§4). |
| HTTP- против SOCKS5-прокси proxy-store | Владелец заказывает 5 http + 5 socks; после выдачи — спайк: рукопожатие с Telegram через каждый. |
| Определение «заморозки» аккаунта | Уточнить признаки (appConfig / ошибки методов) на этапе плана. |
| `AUTH_KEY_DUPLICATED` при деплое | advisory lock + stop-first деплой воркера. |
| Использование api_id Telegram Desktop | Осознанный выбор владельца; значения — в настройках, переключаемы. |
| Смена api_id в настройках при живых сессиях | `effect: new_connections` — применяется только к новым подключениям; существующие клиенты не переподключаются автоматически. |
