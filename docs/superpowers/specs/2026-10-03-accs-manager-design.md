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
| Судьба tdata | Используется **только для переноса**: из неё извлекается auth key, сама tdata не хранится. Десктоп с перенесённой tdata больше не запускается. | Пользовательское решение. Одновременное использование ключа с разных IP → `AUTH_KEY_DUPLICATED`. |
| Новые сессии | Опционально — вход по **QR-коду** (+ 2FA-пароль) | Сценарий «у меня есть активная сессия, авторизую сервер как новую». |
| Профиль клиента | tdata-аккаунты — профиль Telegram Desktop (его api_id + параметры устройства); QR-аккаунты — собственный api_id с my.telegram.org. Всё в `.env`. | Импортированная сессия не «превращается» резко в другое приложение. |
| Архитектура | **B: `api` и `worker` раздельно**, Redis (BullMQ + pub/sub), один экземпляр воркера | 50+ постоянных MTProto-соединений; рестарт API не рвёт соединения. |
| Прокси | Пул прокси; у аккаунта опциональный (рекомендуемый) прокси; SOCKS5 предпочтителен, HTTP поддерживается | Масштаб 50+ с одного IP; см. §6. |
| Уведомления | Bot API `sendMessage` в приватный канал | Пожелание пользователя; полноценный бот не нужен. |
| Панель | Несколько админов, все равны; логин/пароль; глобальный аудит; первый админ — через CLI | Пожелание пользователя. |
| Фронтенд | React + Vite SPA, TanStack Router/Query, **только shadcn/ui (Base UI)** | Пожелание пользователя. |
| Стек | Node 26 (`node:26-trixie-slim`), PostgreSQL 18, Redis 8, pnpm 12, Hono, Drizzle | Последние стабильные версии на 2026-10-03; Debian вместо alpine — выбор пользователя. |

### Результаты спайков (2026-10-03)

- `@mtcute/convert` прочитал реальный архив пользователя: корень tdata лежал в подпапке
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
   │ auth, audit, │  Redis pub/sub: события    │ proxy checker    │──► proxy-store API
   │ SSE          │                            │ notifier         │──► Bot API → канал
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

### Структура монорепо (pnpm workspaces)

```
apps/
  web/        React + Vite SPA (каркас — shadcn init --template vite --monorepo)
  api/        Hono: REST + SSE + раздача статики web + CLI (admin:*)
  worker/     клиенты mtcute, проверка/синхронизация прокси, уведомления, cron-задачи
packages/
  ui/         компоненты shadcn (создаётся shadcn CLI)
  db/         схема Drizzle, миграции, клиент
  shared/     zod-схемы, контракты команд и событий, env-схема, общие утилиты (crypto)
```

## 4. Модель данных (PostgreSQL, Drizzle)

| Таблица | Поля (ключевые) |
|---|---|
| `admins` | `id`, `login` (unique), `password_hash` (argon2id), `disabled_at`, `last_login_at`, `created_at` |
| `admin_sessions` | `id`, `token_hash`, `admin_id`, `expires_at`, `ip`, `user_agent`, `created_at` |
| `audit_log` | `id`, `actor_type` (`admin`/`system`/`cli`), `admin_id?`, `action`, `target_type?`, `target_id?`, `payload` jsonb (очищен от секретов), `ip?`, `user_agent?`, `status_code?`, `result` (`ok`/`error`), `duration_ms?`, `created_at` |
| `accounts` | `id`, `tg_user_id` (unique), `phone`, `username`, `first_name`, `last_name`, `is_premium`, `dc_id`, `label`, `note`, `source` (`tdata`/`qr`), `client_profile` (`desktop`/`own`), `device` jsonb (model, system, app version, lang — фиксируются при добавлении), `connection_mode` (`proxy`/`direct`), `proxy_id?` (FK, unique), `status`, `status_reason`, `status_changed_at`, `last_ok_at`, `created_at`, `updated_at` |
| `account_auth` | `account_id` (PK/FK), `dc_id`, `auth_key_enc` |
| `proxies` | `id`, `source` (`manual`/`proxy_store`), `external_id?`, `type` (`socks5`/`http`), `host`, `port`, `username?`, `password_enc?`, `tag?`, `status`, `last_check_at`, `last_ok_at`, `latency_ms`, `last_error`, `fail_streak`, `expires_at?`, `provider_meta` jsonb, `disabled_at?`, `created_at`, `updated_at`. Unique: (`type`,`host`,`port`,`username`); unique (`source`,`external_id`) |
| `code_messages` | `id`, `account_id`, `tg_message_id`, `date`, `text`, `code?`, `notified_at?`, `created_at`. Unique (`account_id`,`tg_message_id`) |
| `import_batches` | `id`, `admin_id`, `filename`, `status`, `created_at`, `expires_at` (TTL 1 час) |
| `import_items` | `id`, `batch_id`, `path_in_archive`, `account_index`, `tg_user_id`, `dc_id`, `auth_key_enc`, `duplicate_of?`, `decision` (`pending`/`imported`/`skipped`), `error?` |

Плюс служебные таблицы `@mtcute/postgres` (кеш пиров, состояние апдейтов), разделённые
по `account: <accounts.id>`.

**Не в Postgres:** состояние активного QR-входа (Redis, TTL); список активных сессий
аккаунта (запрашивается у Telegram на лету через `account.getAuthorizations`).

**Удержание:** `code_messages` старше `MESSAGE_RETENTION_DAYS` (30) удаляются cron-задачей;
неподтверждённые `import_*` удаляются по `expires_at`.

### Шифрование

- AES-256-GCM, мастер-ключ `APP_ENCRYPTION_KEY` (32 байта, base64) только в `.env`.
- Формат шифротекста: `v1:<iv>:<ciphertext>:<tag>` (base64) — префикс версии ключа
  для будущей ротации.
- Шифруются: `account_auth.auth_key_enc`, `import_items.auth_key_enc`, `proxies.password_enc`.
- `@mtcute/postgres` хранит auth key открытым текстом. Требование: ключ в его таблицах
  **не хранится в открытом виде**. Способ (подмена репозитория auth keys в хранилище mtcute
  на шифрующую обёртку над `account_auth`, либо собственный storage-провайдер) выбирается
  и проверяется на этапе плана.

## 5. Воркер и жизненный цикл аккаунта

### Старт и остановка

- Захват `pg_advisory_lock` → загрузка аккаунтов в рабочих статусах → подъём клиентов
  порциями по `CONNECT_CONCURRENCY` (5) с джиттером.
- SIGTERM: прекратить приём задач → `destroy()` всех клиентов → отпустить lock.
  `stop_grace_period: 30s`.

### Клиент аккаунта

`TelegramClient` с: хранилищем в Postgres (шифрованный ключ), транспортом по
`connection_mode` и типу прокси (`SocksProxyTcpTransport` / `HttpProxyTcpTransport` /
прямой TCP), `apiId`/`apiHash` и параметрами устройства из профиля аккаунта.
Короткие `FLOOD_WAIT` mtcute переживает сам (`floodSleepThreshold`), длинные — задача
повторяется позже.

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
дополнительно предупреждение в канал. Клиент **никогда** не переключается на прямое
подключение сам.

### Коды

1. Новое входящее сообщение от `777000` → извлечение кода: первое отдельно стоящее
   число из 5–6 цифр, иначе `null` (полный текст сохраняется всегда).
2. Upsert в `code_messages` → событие `code.new` → задача `notify` (BullMQ, ретраи с backoff)
   → Bot API `sendMessage` в `NOTIFY_CHAT_ID` → `notified_at`.
3. При каждом (пере)подключении — догрузка истории `777000` начиная с последнего
   сохранённого `tg_message_id` (идемпотентно за счёт unique-ключа). Уведомления при
   догрузке — только для сообщений моложе `NOTIFY_MAX_AGE` (10 мин).

Формат уведомления: метка (или телефон) аккаунта, код, время, полный текст.

### Профиль

`getMe` при подключении и раз в `PROFILE_REFRESH_INTERVAL` (6 ч) → телефон, username,
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

- `GET https://proxy-store.com/api/{PROXY_STORE_API_KEY}/getproxy/` раз в
  `PROXY_SYNC_INTERVAL` (15 мин) и по кнопке. Ключ — только в `.env`.
- Фильтр: `country = PROXY_STORE_COUNTRY` (`kz`), `category = PROXY_STORE_CATEGORY`
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
- По расписанию (`PROXY_CHECK_INTERVAL`), сразу после добавления и внепланово при потере
  соединения клиентом.
- 1 неудача → `failing` (учащённые перепроверки); 3 подряд → `dead` → привязанный
  аккаунт `proxy_down`. Успешная проверка → `ok` → аккаунт в `proxy_down` возобновляется
  автоматически.
- Статусы: `provisioning` → `unchecked` → `ok` / `failing` / `dead` / `expired`.
- За `PROXY_EXPIRY_WARN_DAYS` (3) до `expires_at` — предупреждение в канал со списком
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
     zip-бомб (`IMPORT_MAX_ZIP_MB`, `IMPORT_MAX_FILES`, лимит распакованного размера);
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
3. Успех → аккаунт `active`, ключ шифруется в `account_auth`. Общий таймаут — 5 минут.

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
| Аудит | `GET /audit` (фильтры: админ, действие, период) |
| События | `GET /events` (SSE: `code.new`, `account.status`, `proxy.status`, `import.progress`) |
| Служебное | `GET /healthz` |

### Безопасность

- Пароли — argon2id (`node:crypto`). Сессия — случайный токен в cookie
  `httpOnly; Secure; SameSite=Strict`, в БД только хеш. Срок — `SESSION_TTL`.
- CSRF: для изменяющих запросов проверяется `Origin` против `PUBLIC_ORIGIN`.
- Rate limit на `/auth/login` в Redis по IP и по логину.
- `TRUST_PROXY` — доверять `X-Forwarded-For` от внешнего reverse proxy.

### Аудит

Глобальный middleware пишет в `audit_log`:

- все `POST/PUT/PATCH/DELETE`;
- вход/выход, включая неудачные попытки;
- чувствительные чтения (`GET /accounts/:id/sessions`).

Поля: актор, `action` (из метаданных роута, например `account.update`, `proxy.import`),
`target` из параметров, IP, user-agent, HTTP-статус, длительность, тело запроса после
санитайзера (`password`, `passcode`, ключи, пароли прокси, содержимое файлов →
`[redacted]`). Запись выполняется и при ошибке обработчика.

### CLI

`admin:create --login <login>`, `admin:reset-password --login <login>`,
`admin:disable --login <login>`. Пароль — интерактивно или `--password-stdin`.
В контейнере: `docker compose exec api node dist/cli.js admin:create --login <login>`.
Действия CLI — в аудит с `actor_type=cli`.

## 9. UI

**Правило:** весь UI строится из компонентов shadcn/ui (Base UI) по правилам скилла
`shadcn` (`.claude/skills/shadcn`): семантические токены цвета, `FieldGroup`/`Field` для
форм, `gap-*` вместо `space-*`, `Badge`/`Empty`/`Skeleton`/`Alert`/`toast` вместо
кастомной разметки. Отсутствующий элемент — сначала `shadcn search`; сторонние реестры —
только с явного согласия владельца проекта.

### Навигация

- **Desktop:** верхний navbar, без sidebar. Слева — название; табы
  **Коды · Аккаунты · Прокси · Аудит · Админы** (`NavigationMenu`, ссылки TanStack Router
  через `render`, стиль line-табов, активный по текущему маршруту). Справа — индикатор
  SSE-соединения и `DropdownMenu` админа (`Avatar` + `AvatarFallback`): сменить пароль, выйти.
- **Mobile (< md):** бургер (`Button`) → `Sheet` слева (с `SheetTitle`) с теми же пунктами
  вертикально.

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

Пустые состояния — `Empty`, загрузка — `Skeleton`, ошибки — `Alert`. Тема — светлая/тёмная
по системной.

### Каркас

`shadcn init --template vite --monorepo` с пресетом на Base UI (пресет выбирает владелец
проекта: `base-nova` или код с ui.shadcn.com) → `apps/web` + `packages/ui`.

## 10. Инфраструктура

### Docker

- Один multi-stage `Dockerfile`, база `node:26-trixie-slim`, pnpm 12 через corepack:
  `deps` → `build` → `pnpm deploy --prod` → runtime-образы `api` (со статикой web) и
  `worker`. Пользователь `node`, `--init`, healthcheck.
- **Правило:** без нативных зависимостей там, где есть чистый JS/WASM; при проблемах
  с образом — менять базу, а не архитектуру.
- `compose.yml`:
  - `postgres:18-trixie` — volume на `/var/lib/postgresql` (с v18 образ хранит `PGDATA`
    в версионированном подкаталоге);
  - `redis:8-trixie` — `appendonly yes`, `maxmemory-policy noeviction` (требование BullMQ);
  - `migrate` — одноразовый, миграции Drizzle; `api`/`worker` зависят от
    `service_completed_successfully`;
  - `api` — порт `3000`; `worker` — без портов, `stop_grace_period: 30s`;
  - Postgres и Redis наружу не публикуются.
- `compose.dev.yml` — порты Postgres/Redis для локальной разработки; приложения
  в dev — `pnpm dev`, Vite проксирует `/api` на api.

### `.env`

В репозитории — `.env.example`; `.env` — в `.gitignore`. Валидация zod при старте
каждого процесса (fail fast).

| Группа | Переменные |
|---|---|
| Инфраструктура | `DATABASE_URL`, `REDIS_URL`, `PUBLIC_ORIGIN`, `TRUST_PROXY`, `LOG_LEVEL` |
| Шифрование | `APP_ENCRYPTION_KEY` |
| Telegram | `TG_DESKTOP_API_ID`, `TG_DESKTOP_API_HASH`, `TG_DESKTOP_DEVICE_MODEL`, `TG_DESKTOP_SYSTEM_VERSION`, `TG_DESKTOP_APP_VERSION`, `TG_OWN_API_ID`, `TG_OWN_API_HASH` |
| Уведомления | `NOTIFY_BOT_TOKEN`, `NOTIFY_CHAT_ID`, `NOTIFY_MAX_AGE` |
| Прокси | `PROXY_STORE_API_KEY`, `PROXY_STORE_COUNTRY`, `PROXY_STORE_CATEGORY`, `PROXY_SYNC_INTERVAL`, `PROXY_CHECK_INTERVAL`, `PROXY_EXPIRY_WARN_DAYS` |
| Лимиты | `CONNECT_CONCURRENCY`, `PROFILE_REFRESH_INTERVAL`, `MESSAGE_RETENTION_DAYS`, `IMPORT_MAX_ZIP_MB`, `IMPORT_MAX_FILES`, `SESSION_TTL` |

Логи — pino (JSON) с redaction ключей, паролей, токенов.

### CI (GitHub Actions)

`ci.yml` с первого коммита: lint, typecheck, тесты (сервисы Postgres 18 и Redis 8),
сборка Docker-образов. Деплой (GHCR + ssh, stop-first для воркера) — отдельная задача.

### Гигиена репозитория

`.gitignore`: `.env`, `tdata-samples/`, `*.zip`, `.DS_Store`, `node_modules`, `dist`.
Скиллы проекта (`.agents/`, `.claude/skills/`, `skills-lock.json`) коммитятся.

## 11. Тестирование (Vitest)

- **Unit:** поиск tdata в zip (вложенность, несколько корней, zip-slip, лимиты);
  извлечение кода из текстов `777000` (RU/EN); парсер списков прокси; маппинг
  proxy-store (`provisioning`, `expired`, смена данных); шифрование (round-trip, подмена
  шифротекста); санитайзер аудита; переходы статусов аккаунта.
- Тестовые tdata **генерируются в тестах** через `convertToTdata` со случайными ключами;
  реальные ключи в репозиторий не попадают.
- **Интеграционные:** API на реальных Postgres/Redis — вход, rate limit, аудит, путь
  импорта. Воркер работает через интерфейс `TelegramGateway`; в тестах — фейковая
  реализация, CI в Telegram не ходит.
- **E2E smoke (Playwright):** вход, переход по табам, мобильное меню в `Sheet`.
- **Реальный Telegram** — только ручные проверки и спайки.

## 12. Риски и открытые вопросы

| Риск | Что делаем |
|---|---|
| tdata, записанная самим TDesktop 7.x, не проверена (образец — v3.4.0) | `ignoreVersion: true`; прогнать спайк на «живой» tdata 7.x, как только появится. Запасной путь — Python-конвертер (opentele2/TGConvertor) как отдельная утилита. |
| Встраивание шифрования ключа в хранилище mtcute | Выбрать и проверить подход на этапе плана (§4). |
| HTTP- против SOCKS5-прокси proxy-store | Пользователь заказывает 5 http + 5 socks; после выдачи — спайк: рукопожатие с Telegram через каждый. |
| Определение «заморозки» аккаунта | Уточнить признаки (appConfig / ошибки методов) на этапе плана. |
| `AUTH_KEY_DUPLICATED` при деплое | advisory lock + stop-first деплой воркера. |
| Использование api_id Telegram Desktop | Осознанный выбор владельца; значения только в `.env`, переключаемы. |
