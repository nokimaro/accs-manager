# План 2 — Воркер, прокси, Telegram: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Довести панель до рабочего состояния. Воркер держит Telegram-аккаунты (из tdata и по QR) через прокси и собирает коды из @VerificationCodes в живую ленту. Новые коды дублируются в приватный канал. Пул прокси собирается вручную, импортом и из proxy-store, его здоровье проверяется.

**Architecture:**
- **`apps/worker`** — отдельный процесс, ровно один экземпляр (`pg_advisory_lock`). Он единственный владелец клиентов mtcute.
- **Связь с API:**
  - команды — BullMQ-очередь `worker-commands` (`send`/`call`);
  - события — Redis pub/sub → SSE;
  - живость — heartbeat в Redis.
- **Хранилище mtcute** — `@mtcute/postgres` в схеме `mtcute`. Auth keys хранятся отдельно: шифруются в `account_auth`.
- **API не ходит в Telegram.** Он разбирает tdata (zip → string session, шифруется) и пишет решения в БД. Воркер подключает аккаунты через назначенный прокси, напрямую — только по явному выбору.
- **Web** — страницы «Коды», «Аккаунты» (+ карточка), «Прокси», обновление по событиям.

**Tech Stack:** план 1 (Node 26.10, pnpm 12.8.2, Hono 4, Drizzle 0.45, PostgreSQL 18, Redis 8, Zod 4, React 19, TanStack Router/Query/Table, shadcn на Base UI, Vitest 5, Playwright), а также:
- mtcute 0.32.3: `@mtcute/node`, `@mtcute/core`, `@mtcute/convert`, `@mtcute/postgres`;
- BullMQ 6.3;
- fflate 0.8;
- qrcode 1.5.

**Spec:** `docs/superpowers/specs/2026-10-03-accs-manager-design.md`. Исполнитель читает спеку и план вместе; расхождения перечислены в «Уточнениях к спеке».

**Как получен код:** весь код плана сначала написан и прогнан в песочнице, по задаче на коммит; каждая задача проверена отдельно (typecheck, lint, тесты).
- **Итог:** 274 теста vitest (shared/db/server/api/web/worker; интеграционные на Postgres 18 и Redis 8) и 18 e2e (desktop + Pixel 7).
- **Docker-образ:** собран, воркер из него стартует и корректно останавливается.
- **Живая проверка (задача 19):** архив владельца из `tdata-samples/` подключён через KZ-прокси 194.53.188.x. Аккаунт `active`, профиль загружен. В Telegram сессия видна как «Telegram Desktop 7.2.9 x64, Windows 11 x64».
- **Баг, найденный на живой проверке:** не запускался цикл обновлений mtcute. Исправление уже внутри задачи 11.

## Global Constraints

- **Всё из Global Constraints плана 1 в силе:**
  - Node 26 через `fnm exec --using=26`, pnpm 12.8.2;
  - зависимости — мажорными диапазонами (`'pkg@^N'`, для 0.x — `'pkg@^0.N'`);
  - `.env` — только инфраструктура;
  - `erasableSyntaxOnly`, импорты с `.ts`;
  - весь UI — shadcn (Base UI) по скиллу `.claude/skills/shadcn`, тексты на русском;
  - Docker-ресурсы с префиксом `accs-`;
  - шифротекст `v1:<iv>:<ct>:<tag>`.
- **mtcute** — `^0.32` (проверено на 0.32.3). TL layer 229: кнопка Copy Code — `keyboardInlineButton` с `type = inlineButtonTypeCopy { copyText }`.
- **Drizzle-операторы** (`eq`, `and`, `or`, `inArray`, `isNull`, `sql`, `desc`, `lt`, `max`, тип `SQL`, …) в `apps/*` импортируются **только из `@workspace/db`**. `drizzle-orm` прямой зависимостью приложений не бывает.
- **Сборки пакетов в `pnpm-workspace.yaml`** запрещены (`allowBuilds`): `msgpackr-extract: false`, `better-sqlite3: false`.
- **Коды — только из чата @VerificationCodes** (`CODE_SOURCE_USERNAME = 'VerificationCodes'`). Чат 777000 не отслеживается.
- **Формат уведомления о коде — дословно:** `<code>+77001234567</code> получен код <code>575571</code>` (`parse_mode: HTML`).
- **Ни один аккаунт не подключается напрямую без явного выбора админа** (`connection_mode = 'direct'`). Недоступный прокси → `proxy_down`, а не fallback.
- **Один воркер:** `pg_advisory_lock`. Деплой stop-first: два процесса никогда не держат один auth key.
- **Секреты нигде не появляются** — ни в ответах API, ни в логах, ни в аудите, ни в тестовых фикстурах:
  - API-ключ proxy-store, токен бота, пароли прокси;
  - пароль 2FA при QR-входе, локальный код-пароль tdata;
  - auth keys.
- **Тесты в Telegram не ходят:** воркер тестируется через `TelegramSession`/`QrClient`-фейки, tdata генерируется `convertToTdata` со случайным ключом.
- **Коммиты:** после каждой задачи — локальный `git commit`. **Никогда не `git push`**: пуш в `main` = деплой в прод, только после плана и с согласия владельца.

## Уточнения к спеке, принятые в плане

1. **Маршруты API:**
   - `/api/qr` вместо `/qr-logins`; прогресс QR — событие `qr.update` в общем SSE `/api/events`, а не отдельный поток;
   - коды — `GET /api/codes?accountId=&before=&limit=` (вместо `/messages` и `/accounts/:id/messages`);
   - `POST /accounts/:id/reconnect` вместо `check`;
   - импорт прокси — `POST /proxies/import/preview` + `POST /proxies/import` вместо `?dryRun`;
   - добавлен `GET /proxies/sync-status`.
2. **SSE-события** — «изменилось, перечитай»: `proxies.changed`, `accounts.changed`, `code.new`, `qr.update` (вместо `account.status`, `proxy.status`, `import.progress`; импорт синхронный).
3. **Команды воркеру:** `account.sync|stop|sessions|terminateSession`, `proxy.check|sync`, `qr.start`.
   - Подтверждение импорта и смену прокси API пишет в БД сам и отправляет `account.sync`.
   - Пароль 2FA и отмена QR — Redis pub/sub `accs:qr:<id>`, не очередь (пароль не попадает в Redis-хранилище задач).
4. **Проверка прокси двухуровневая:**
   - каждый интервал — TCP-туннель до DC2 через прокси (задержка);
   - не чаще раза в сутки — MTProto `help.getNearestDc` (страна).

   Назначать можно прокси со статусом `ok`, `unchecked` или `failing`, не отключённый и не занятый (в спеке — только `ok`): так свежедобавленный прокси можно назначить сразу. `dead`, `expired`, `provisioning` назначить нельзя.
5. **`account_auth`** — PK `(account_id, dc_id)`: mtcute хранит ключи нескольких DC (основной и медиа).
6. **Импорт и QR не пишут ключ в `account_auth` сами.** String session шифруется в `accounts.session_import_enc`; воркер импортирует её при первом подключении и обнуляет. QR-клиент живёт в `MemoryStorage`, пока аккаунта нет.
7. **Docker:** один образ (target `api`) для api и воркера. У `accs-worker` своя `command`, healthcheck образа выключен (состояние — heartbeat). Deploy-job ждёт и `version`, и `workerVersion`.
8. **Интерфейс воркера к Telegram** — `TelegramSession` (в спеке — `TelegramGateway`).
9. **UI:** фильтр ленты кодов по аккаунту — `Select` (а не `Combobox`), значение хранится в URL (`?account=`); текст сообщения показывается целиком, без раскрытия.

## Review Focus

Режимы отказа, которые спека подразумевает, но прямо не проговаривает. Каждый закреплён тестом в задаче-владельце.

1. **Аккаунт подключён, но живые коды не приходят.**
   - Причина: в mtcute цикл обновлений запускает только `notifyLoggedIn` (его вызывает `client.start()`). Ручной `connect()` + `getMe()` оставляет клиент глухим.
   - Ожидание: после старта сессии вызывается `notifyLoggedIn(me.raw)`.
   - Тест — задача 11, `mtcute-session.test.ts` «starts the updates loop after connecting».
2. **Кнопки «Проверить»/«Синхронизировать»/«Переподключить»/пароль 2FA получают 202 без тела.**
   - Ожидание: успех, а не ошибка разбора JSON.
   - Тест — задача 8, `api.test.ts` «returns … undefined for empty answers».
3. **Событие QR пришло раньше ответа `POST /qr`** (воркер быстрее HTTP-ответа).
   - Ожидание: QR всё равно показывается.
   - Тест — задача 16, `qr-login-tab.test.tsx` «keeps one that arrives before POST /qr answers».
4. **Свободных прокси нет.**
   - Ожидание: ни импорт, ни QR не уходят «напрямую» сами:
     - `auto` при пустом пуле — отказ API;
     - в UI новые строки — «Не добавлять», QR ждёт явного выбора.
   - Тесты — задача 10, `imports.test.ts` «refuses … an empty pool for "auto"»; задача 16, «without free proxies …» в `import-tdata-tab.test.tsx` и `qr-login-tab.test.tsx`.
5. **Удаление аккаунта «с выходом из Telegram», когда он не подключён.**
   - Ожидание: 409 `logout_failed`, данные на месте (иначе сессия осталась бы жить без панели).
   - Тест — задача 14, `accounts.test.ts` «with logout only when it really logged out».

## Перед началом

- **Один auth key — одно место.** Перед задачей 19 убедиться, что архив из `tdata-samples/` нигде не подключён:
  - песочница этого плана — аккаунт там на паузе;
  - локальный dev;
  - Telegram Desktop.
- **Локальный `pnpm dev`** с задачи 4 запускает и воркер (`node --watch`). Он подключает аккаунты из локальной БД — правило выше касается и его.
- **Порты dev** (`DEV_PG_PORT=25432`, `DEV_REDIS_PORT=26379`) — как в плане 1. Интеграционные тесты сами поднимают Postgres/Redis через testcontainers.

## Файловая структура

```
packages/
  shared/src/{proxies,accounts,commands}.ts      # + events.ts: proxies.changed, accounts.changed, code.new, qr.update
  db/src/schema.ts, drizzle/0001_telegram.sql, 0002_proxy_country_check.sql
  server/src/{queues,heartbeat}.ts                # + redis.ts: соединения для BullMQ
apps/
  api/src/lib/{errors,zip}.ts
      services/{proxies,imports,accounts}.ts
      routes/{proxies,imports,accounts,codes,qr}.ts
  worker/src/main.ts · deps.ts · lock.ts · runtime.ts · schedule.ts · housekeeping.ts
         proxies/{checker,health,proxy-store}.ts
         telegram/{session,mtcute-session,storage,errors}.ts
         accounts/manager.ts · codes/{extract,collector}.ts · notify/{format,bot-api,notifier}.ts · qr/{client,login}.ts
  web/src/lib/{proxies,accounts,app-events}.ts
         components/proxies/*, components/accounts/*, components/codes/*
         routes/_authed/{index,proxies}.tsx, routes/_authed/accounts/{index,$id}.tsx
         test/{render.tsx,fixtures.ts}
e2e/telegram.spec.ts · compose.yml/compose.prod.yml (accs-worker) · Dockerfile · .github/workflows/ci.yml · AGENTS.md · deploy/README.md
```

## Задачи

| # | Задача | Результат |
|---|---|---|
| 1 | Схема БД: прокси, аккаунты, ключи, импорт, коды | 6 таблиц, миграция `0001_telegram` |
| 2 | `shared`: прокси, аккаунты, команды воркеру, события | парсер списков прокси, DTO, схемы команд и событий |
| 3 | `server`: очередь команд воркеру | `createCommandClient` (send/call), Redis для BullMQ |
| 4 | Процесс воркера: lock, очереди, heartbeat | `apps/worker`, `accs-worker` в compose, healthz показывает воркер |
| 5 | API прокси | CRUD, импорт с предпросмотром, check/sync |
| 6 | Проверка здоровья прокси | туннель каждый интервал, страна раз в сутки, `failing`/`dead` |
| 7 | Синхронизация с proxy-store | автосписок `kz`/`for_all`, статус последней синхронизации |
| 8 | Web: страница «Прокси» | таблица, фильтры, добавление, импорт, sync/check |
| 9 | Хранилище mtcute с зашифрованными ключами | `createAccountStorage`, `EncryptedAuthKeys` |
| 10 | Импорт tdata в API | `POST /imports`, `GET /imports/:id`, `POST /imports/:id/confirm` |
| 11 | Менеджер аккаунтов в воркере | жизненный цикл клиентов, статусы, повторы, команды |
| 12 | Коды из @VerificationCodes | сборщик, извлечение кода, `GET /api/codes`, уборка |
| 13 | Уведомления в канал | очередь `notify`, формат кода, предупреждения |
| 14 | API аккаунтов | список, карточка, прокси, пауза, удаление, сессии |
| 15 | Вход по QR | `POST /qr`, пароль 2FA и отмена через pub/sub, `qr.update` |
| 16 | Web: аккаунты | список, «Добавить аккаунт» (tdata/QR), карточка |
| 17 | Web: лента кодов | главная — живая лента с фильтром и подгрузкой |
| 18 | Деплой, e2e, документация | деплой ждёт версию воркера, e2e 18, AGENTS.md |
| 19 | Живая проверка на архиве владельца | аккаунт `active` через KZ-прокси, коды и уведомления |

---

### Task 1: Схема БД: прокси, аккаунты, ключи, импорт, коды

Таблицы из §4 спеки и миграция. Решения, которые дальше опираются на схему: endpoint прокси уникален по `(type, host, port, username)` с `NULLS NOT DISTINCT`, у proxy-store ещё unique `(source, external_id)`; `accounts.proxy_id` unique — один прокси на один аккаунт; `accounts.device` (jsonb) фиксирует параметры устройства при добавлении; `accounts.session_import_enc` — зашифрованная string session из tdata/QR, воркер применяет её один раз; `account_auth` с PK `(account_id, dc_id)` — mtcute хранит ключи нескольких DC; `code_messages` unique `(account_id, tg_message_id)` — повторная догрузка истории идемпотентна.

**Files:**
- Create: `packages/db/drizzle/0001_telegram.sql`
- Modify: `packages/db/src/index.ts`
- Modify: `packages/db/src/schema.ts`
- Test (modify): `packages/db/test/schema.test.ts`
- Generated: `packages/db/drizzle/meta/0001_snapshot.json`, `packages/db/drizzle/meta/_journal.json` — не писать руками (команды ниже)

**Interfaces:**
- Consumes: `packages/db` из плана 1 (`schema.ts`, `jsonb`-тип колонки, `testing.ts` с `createTestDatabase`).
- Produces:
  - `packages/db/src/schema.ts`: `PROXY_SOURCES`; `PROXY_TYPES`; `PROXY_STATUSES`; `proxies`; `ACCOUNT_SOURCES`; `CLIENT_PROFILES`; `CONNECTION_MODES`; `ACCOUNT_STATUSES`; `interface AccountDevice`; `accounts`; `accountAuth`; `IMPORT_BATCH_STATUSES`; `IMPORT_DECISIONS`; `importBatches`; `importItems`; `codeMessages`

- [ ] **Шаг 1: Написать падающий тест**

`packages/db/test/schema.test.ts` — изменения

```diff
--- a/packages/db/test/schema.test.ts
+++ b/packages/db/test/schema.test.ts
@@ -1,6 +1,6 @@
 import { eq, sql } from 'drizzle-orm'
 import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'
-import { admins, adminSessions, settings } from '../src/index.ts'
+import { accountAuth, accounts, admins, adminSessions, codeMessages, proxies, settings } from '../src/index.ts'
 import { createTestDatabase, type TestDatabase } from '../src/testing.ts'
 
 let t: TestDatabase
@@ -17,7 +17,7 @@ describe('schema', () => {
     const { runMigrations } = await import('../src/migrate.ts')
     await runMigrations(t.db)
     const res = await t.db.execute(sql`select count(*)::int as n from information_schema.tables where table_schema = 'public'`)
-    expect(res.rows[0]).toEqual({ n: 4 })
+    expect(res.rows[0]).toEqual({ n: 10 })
   })
 
   it('enforces unique admin login', async () => {
@@ -48,4 +48,37 @@ describe('schema', () => {
     const rows = await t.db.select().from(settings)
     expect(values.map((v) => rows.find((r) => r.key === `str:${v}`)?.value)).toEqual(values)
   })
+
+  const device = { deviceModel: 'Desktop', systemVersion: 'Windows 11 x64', appVersion: '7.2.9 x64', langCode: 'ru' }
+  const account = (tgUserId: number, proxyId: string | null = null) =>
+    ({ tgUserId, source: 'tdata', clientProfile: 'desktop', device, connectionMode: proxyId ? 'proxy' : 'direct', proxyId }) as const
+
+  it('treats a proxy without login as one endpoint (NULLS NOT DISTINCT)', async () => {
+    const row = { source: 'manual', type: 'socks5', host: '10.0.0.1', port: 1080 } as const
+    await t.db.insert(proxies).values(row)
+    await expect(t.db.insert(proxies).values(row)).rejects.toThrow()
+    await t.db.insert(proxies).values({ ...row, username: 'u' })
+  })
+
+  it('binds one proxy to at most one account and frees it when the proxy goes', async () => {
+    const [p] = await t.db.insert(proxies).values({ source: 'manual', type: 'http', host: '10.0.0.2', port: 3128 }).returning()
+    const [a] = await t.db.insert(accounts).values(account(1001, p!.id)).returning()
+    await expect(t.db.insert(accounts).values(account(1002, p!.id))).rejects.toThrow()
+    await t.db.delete(proxies).where(eq(proxies.id, p!.id))
+    const [after] = await t.db.select().from(accounts).where(eq(accounts.id, a!.id))
+    expect(after).toMatchObject({ proxyId: null, status: 'pending_check', device })
+  })
+
+  it('removes auth keys and codes together with the account', async () => {
+    const [a] = await t.db.insert(accounts).values(account(2001)).returning()
+    await t.db.insert(accountAuth).values([
+      { accountId: a!.id, dcId: 2, authKeyEnc: 'v1:a:b:c' },
+      { accountId: a!.id, dcId: 4, authKeyEnc: 'v1:d:e:f' },
+    ])
+    await t.db.insert(codeMessages).values({ accountId: a!.id, tgMessageId: 7, date: new Date(), text: 'Your code is 123456', code: '123456' })
+    await expect(t.db.insert(codeMessages).values({ accountId: a!.id, tgMessageId: 7, date: new Date(), text: 'dup' })).rejects.toThrow()
+    await t.db.delete(accounts).where(eq(accounts.id, a!.id))
+    expect(await t.db.select().from(accountAuth).where(eq(accountAuth.accountId, a!.id))).toEqual([])
+    expect(await t.db.select().from(codeMessages).where(eq(codeMessages.accountId, a!.id))).toEqual([])
+  })
 })
```

- [ ] **Шаг 2: Убедиться, что тест падает**

```bash
fnm exec --using=26 npx vitest run --project db
# FAIL: в схеме 4 таблицы, тест ждёт 10
```

- [ ] **Шаг 3: Реализация**

`packages/db/src/index.ts` — изменения

```diff
--- a/packages/db/src/index.ts
+++ b/packages/db/src/index.ts
@@ -1,4 +1,16 @@
 export * from './client.ts'
 export * from './migrate.ts'
 export * as schema from './schema.ts'
-export { admins, adminSessions, auditLog, settings } from './schema.ts'
+export {
+  accountAuth,
+  accounts,
+  admins,
+  adminSessions,
+  auditLog,
+  codeMessages,
+  importBatches,
+  importItems,
+  proxies,
+  settings,
+  type AccountDevice,
+} from './schema.ts'
```

`packages/db/src/schema.ts` — изменения

```diff
--- a/packages/db/src/schema.ts
+++ b/packages/db/src/schema.ts
@@ -1,6 +1,12 @@
-import { bigserial, customType, index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
+import { bigint, bigserial, boolean, customType, index, integer, pgTable, primaryKey, text, timestamp, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
 
 const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
+const updatedAt = () =>
+  timestamp('updated_at', { withTimezone: true })
+    .notNull()
+    .defaultNow()
+    .$onUpdate(() => new Date())
+const ts = (name: string) => timestamp(name, { withTimezone: true })
 
 /**
  * jsonb that returns what was stored. node-postgres already parses jsonb, and drizzle's jsonb() then
@@ -73,3 +79,153 @@ export const settings = pgTable('settings', {
   updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
   updatedBy: uuid('updated_by').references(() => admins.id, { onDelete: 'set null' }),
 })
+
+// ---- plan 2: proxies, Telegram accounts, codes ----
+
+export const PROXY_SOURCES = ['manual', 'proxy_store'] as const
+export const PROXY_TYPES = ['socks5', 'http'] as const
+export const PROXY_STATUSES = ['provisioning', 'unchecked', 'ok', 'failing', 'dead', 'expired'] as const
+
+export const proxies = pgTable(
+  'proxies',
+  {
+    id: uuid('id').primaryKey().defaultRandom(),
+    source: text('source', { enum: PROXY_SOURCES }).notNull(),
+    /** proxy-store id; null for manual proxies */
+    externalId: text('external_id'),
+    type: text('type', { enum: PROXY_TYPES }).notNull(),
+    host: text('host').notNull(),
+    port: integer('port').notNull(),
+    username: text('username'),
+    passwordEnc: text('password_enc'),
+    tag: text('tag'),
+    status: text('status', { enum: PROXY_STATUSES }).notNull().default('unchecked'),
+    lastCheckAt: ts('last_check_at'),
+    lastOkAt: ts('last_ok_at'),
+    latencyMs: integer('latency_ms'),
+    /** country of the exit IP as Telegram sees it (help.getNearestDc); shown only */
+    tgCountry: text('tg_country'),
+    lastError: text('last_error'),
+    failStreak: integer('fail_streak').notNull().default(0),
+    expiresAt: ts('expires_at'),
+    expiryWarnedAt: ts('expiry_warned_at'),
+    providerMeta: jsonb('provider_meta'),
+    disabledAt: ts('disabled_at'),
+    createdAt: createdAt(),
+    updatedAt: updatedAt(),
+  },
+  (t) => [
+    unique('proxies_endpoint_key').on(t.type, t.host, t.port, t.username).nullsNotDistinct(),
+    uniqueIndex('proxies_source_external_key').on(t.source, t.externalId),
+    index('proxies_status_idx').on(t.status),
+  ],
+)
+
+export const ACCOUNT_SOURCES = ['tdata', 'qr'] as const
+export const CLIENT_PROFILES = ['desktop', 'own'] as const
+export const CONNECTION_MODES = ['proxy', 'direct'] as const
+export const ACCOUNT_STATUSES = ['pending_check', 'active', 'paused', 'proxy_down', 'unauthorized', 'banned', 'frozen', 'error'] as const
+
+/** initConnection parameters, fixed when the account is added */
+export interface AccountDevice {
+  deviceModel: string
+  systemVersion: string
+  appVersion: string
+  langCode: string
+}
+
+export const accounts = pgTable(
+  'accounts',
+  {
+    id: uuid('id').primaryKey().defaultRandom(),
+    tgUserId: bigint('tg_user_id', { mode: 'number' }).notNull(),
+    phone: text('phone'),
+    username: text('username'),
+    firstName: text('first_name'),
+    lastName: text('last_name'),
+    isPremium: boolean('is_premium').notNull().default(false),
+    dcId: integer('dc_id'),
+    label: text('label'),
+    note: text('note'),
+    source: text('source', { enum: ACCOUNT_SOURCES }).notNull(),
+    clientProfile: text('client_profile', { enum: CLIENT_PROFILES }).notNull(),
+    device: jsonb('device').$type<AccountDevice>().notNull(),
+    connectionMode: text('connection_mode', { enum: CONNECTION_MODES }).notNull(),
+    proxyId: uuid('proxy_id').references(() => proxies.id, { onDelete: 'set null' }),
+    status: text('status', { enum: ACCOUNT_STATUSES }).notNull().default('pending_check'),
+    statusReason: text('status_reason'),
+    statusChangedAt: timestamp('status_changed_at', { withTimezone: true }).notNull().defaultNow(),
+    lastOkAt: ts('last_ok_at'),
+    /** set while Telegram reports the account frozen (help.getAppConfig.freeze_until_date) */
+    frozenUntil: ts('frozen_until'),
+    /** one-time mtcute string session from a tdata import (encrypted); the worker imports and clears it */
+    sessionImportEnc: text('session_import_enc'),
+    createdAt: createdAt(),
+    updatedAt: updatedAt(),
+  },
+  (t) => [uniqueIndex('accounts_tg_user_id_key').on(t.tgUserId), uniqueIndex('accounts_proxy_id_key').on(t.proxyId), index('accounts_status_idx').on(t.status)],
+)
+
+/** mtcute auth keys, encrypted with APP_ENCRYPTION_KEY (see apps/worker storage) */
+export const accountAuth = pgTable(
+  'account_auth',
+  {
+    accountId: uuid('account_id')
+      .notNull()
+      .references(() => accounts.id, { onDelete: 'cascade' }),
+    dcId: integer('dc_id').notNull(),
+    authKeyEnc: text('auth_key_enc').notNull(),
+    updatedAt: updatedAt(),
+  },
+  (t) => [primaryKey({ columns: [t.accountId, t.dcId] })],
+)
+
+export const IMPORT_BATCH_STATUSES = ['ready', 'confirmed'] as const
+export const IMPORT_DECISIONS = ['pending', 'imported', 'skipped'] as const
+
+export const importBatches = pgTable('import_batches', {
+  id: uuid('id').primaryKey().defaultRandom(),
+  adminId: uuid('admin_id').references(() => admins.id, { onDelete: 'set null' }),
+  filename: text('filename').notNull(),
+  status: text('status', { enum: IMPORT_BATCH_STATUSES }).notNull().default('ready'),
+  createdAt: createdAt(),
+  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
+})
+
+export const importItems = pgTable(
+  'import_items',
+  {
+    id: uuid('id').primaryKey().defaultRandom(),
+    batchId: uuid('batch_id')
+      .notNull()
+      .references(() => importBatches.id, { onDelete: 'cascade' }),
+    pathInArchive: text('path_in_archive').notNull(),
+    accountIndex: integer('account_index').notNull(),
+    tgUserId: bigint('tg_user_id', { mode: 'number' }).notNull(),
+    dcId: integer('dc_id').notNull(),
+    /** mtcute string session (encrypted) */
+    sessionEnc: text('session_enc').notNull(),
+    duplicateOf: uuid('duplicate_of').references(() => accounts.id, { onDelete: 'set null' }),
+    decision: text('decision', { enum: IMPORT_DECISIONS }).notNull().default('pending'),
+    accountId: uuid('account_id').references(() => accounts.id, { onDelete: 'set null' }),
+    error: text('error'),
+  },
+  (t) => [index('import_items_batch_id_idx').on(t.batchId)],
+)
+
+export const codeMessages = pgTable(
+  'code_messages',
+  {
+    id: bigserial('id', { mode: 'number' }).primaryKey(),
+    accountId: uuid('account_id')
+      .notNull()
+      .references(() => accounts.id, { onDelete: 'cascade' }),
+    tgMessageId: integer('tg_message_id').notNull(),
+    date: timestamp('date', { withTimezone: true }).notNull(),
+    text: text('text').notNull(),
+    code: text('code'),
+    notifiedAt: ts('notified_at'),
+    createdAt: createdAt(),
+  },
+  (t) => [uniqueIndex('code_messages_account_message_key').on(t.accountId, t.tgMessageId), index('code_messages_date_idx').on(t.date)],
+)
```

- [ ] **Шаг 4: Сгенерировать миграцию**

```bash
fnm exec --using=26 pnpm --filter @workspace/db db:generate --name telegram
# создаёт packages/db/drizzle/0001_telegram.sql и снимок в packages/db/drizzle/meta/
```

Сверить сгенерированный SQL с ожидаемым (`packages/db/drizzle/0001_telegram.sql`):

```sql
CREATE TABLE "account_auth" (
	"account_id" uuid NOT NULL,
	"dc_id" integer NOT NULL,
	"auth_key_enc" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_auth_account_id_dc_id_pk" PRIMARY KEY("account_id","dc_id")
);
--> statement-breakpoint
CREATE TABLE "accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tg_user_id" bigint NOT NULL,
	"phone" text,
	"username" text,
	"first_name" text,
	"last_name" text,
	"is_premium" boolean DEFAULT false NOT NULL,
	"dc_id" integer,
	"label" text,
	"note" text,
	"source" text NOT NULL,
	"client_profile" text NOT NULL,
	"device" jsonb NOT NULL,
	"connection_mode" text NOT NULL,
	"proxy_id" uuid,
	"status" text DEFAULT 'pending_check' NOT NULL,
	"status_reason" text,
	"status_changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_ok_at" timestamp with time zone,
	"frozen_until" timestamp with time zone,
	"session_import_enc" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "code_messages" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"tg_message_id" integer NOT NULL,
	"date" timestamp with time zone NOT NULL,
	"text" text NOT NULL,
	"code" text,
	"notified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "import_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"admin_id" uuid,
	"filename" text NOT NULL,
	"status" text DEFAULT 'ready' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "import_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"batch_id" uuid NOT NULL,
	"path_in_archive" text NOT NULL,
	"account_index" integer NOT NULL,
	"tg_user_id" bigint NOT NULL,
	"dc_id" integer NOT NULL,
	"session_enc" text NOT NULL,
	"duplicate_of" uuid,
	"decision" text DEFAULT 'pending' NOT NULL,
	"account_id" uuid,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "proxies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source" text NOT NULL,
	"external_id" text,
	"type" text NOT NULL,
	"host" text NOT NULL,
	"port" integer NOT NULL,
	"username" text,
	"password_enc" text,
	"tag" text,
	"status" text DEFAULT 'unchecked' NOT NULL,
	"last_check_at" timestamp with time zone,
	"last_ok_at" timestamp with time zone,
	"latency_ms" integer,
	"tg_country" text,
	"last_error" text,
	"fail_streak" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone,
	"expiry_warned_at" timestamp with time zone,
	"provider_meta" jsonb,
	"disabled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "proxies_endpoint_key" UNIQUE NULLS NOT DISTINCT("type","host","port","username")
);
--> statement-breakpoint
ALTER TABLE "account_auth" ADD CONSTRAINT "account_auth_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_proxy_id_proxies_id_fk" FOREIGN KEY ("proxy_id") REFERENCES "public"."proxies"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "code_messages" ADD CONSTRAINT "code_messages_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_batches" ADD CONSTRAINT "import_batches_admin_id_admins_id_fk" FOREIGN KEY ("admin_id") REFERENCES "public"."admins"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_items" ADD CONSTRAINT "import_items_batch_id_import_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."import_batches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_items" ADD CONSTRAINT "import_items_duplicate_of_accounts_id_fk" FOREIGN KEY ("duplicate_of") REFERENCES "public"."accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_items" ADD CONSTRAINT "import_items_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "accounts_tg_user_id_key" ON "accounts" USING btree ("tg_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "accounts_proxy_id_key" ON "accounts" USING btree ("proxy_id");--> statement-breakpoint
CREATE INDEX "accounts_status_idx" ON "accounts" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "code_messages_account_message_key" ON "code_messages" USING btree ("account_id","tg_message_id");--> statement-breakpoint
CREATE INDEX "code_messages_date_idx" ON "code_messages" USING btree ("date");--> statement-breakpoint
CREATE INDEX "import_items_batch_id_idx" ON "import_items" USING btree ("batch_id");--> statement-breakpoint
CREATE UNIQUE INDEX "proxies_source_external_key" ON "proxies" USING btree ("source","external_id");--> statement-breakpoint
CREATE INDEX "proxies_status_idx" ON "proxies" USING btree ("status");
```

- [ ] **Шаг 5: Проверки**

```bash
fnm exec --using=26 pnpm typecheck
fnm exec --using=26 pnpm lint
fnm exec --using=26 npx vitest run --project db
# всё зелёное
```

- [ ] **Шаг 6: Коммит**

```bash
git add -A
git commit -F - <<'MSG'
feat(db): proxies, accounts, account_auth, imports and code_messages tables
MSG
```

---

### Task 2: `shared`: прокси, аккаунты, команды воркеру, события

Модули без IO, общие для api, воркера и веба. Парсер списков прокси понимает `socks5://user:pass@host:port`, `http://host:port`, `host:port`, `host:port:user:pass`, `user:pass@host:port` (строки без схемы получают тип по умолчанию), пропускает пустые строки и `#`-комментарии, ошибки и повторы возвращает с номером строки. Источник кодов — `CODE_SOURCE_USERNAME = 'VerificationCodes'`. Команды воркеру и события — zod-схемы: то, что приходит из Redis, проверяется.

**Files:**
- Modify: `packages/shared/package.json`
- Create: `packages/shared/src/accounts.ts`
- Create: `packages/shared/src/commands.ts`
- Modify: `packages/shared/src/events.ts`
- Create: `packages/shared/src/proxies.ts`
- Test: `packages/shared/test/accounts.test.ts`
- Test: `packages/shared/test/proxies.test.ts`

**Interfaces:**
- Consumes: `packages/shared` из плана 1 (`events.ts` — расширяется).
- Produces:
  - `packages/shared/src/accounts.ts`: `ACCOUNT_STATUSES`; `type AccountStatus`; `accountStatusLabels: Record<AccountStatus, string>`; `RUNNING_STATUSES: readonly AccountStatus[]`; `FINAL_STATUSES: readonly AccountStatus[]`; `ACCOUNT_SOURCES`; `CLIENT_PROFILES`; `CONNECTION_MODES`; `CODE_SOURCE_USERNAME`; `accountDeviceDto`; `accountProxyRef`; `accountDto`; `type AccountDto`; `updateAccountInput`; `type UpdateAccountInput`; `setAccountProxyInput`; `type SetAccountProxyInput`; `deleteAccountQuery`; `accountSessionDto`; `type AccountSessionDto`; `importItemDto`; `type ImportItemDto`; `importBatchDto`; `type ImportBatchDto`; `confirmImportInput`; `type ConfirmImportInput`; `confirmImportResult`; `type ConfirmImportResult`; `codeDto`; `type CodeDto`; `codesQuery`; `type CodesQuery`; `startQrInput`; `type StartQrInput`; `qrPasswordInput`; `QR_STATES`; `type QrState`; `accountTitle(a: { label?: string | null; phone?: string | null; username?: string | null; tgUserId?: number | null }): string`
  - `packages/shared/src/commands.ts`: `COMMANDS_QUEUE`; `workerCommandSchema`; `type WorkerCommand`; `type WorkerCommandType`; `qrControlChannel`; `qrControlSchema`; `type QrControl`
  - `packages/shared/src/proxies.ts`: `PROXY_TYPES`; `type ProxyType`; `PROXY_SOURCES`; `type ProxySource`; `PROXY_STATUSES`; `type ProxyStatus`; `proxyStatusLabels: Record<ProxyStatus, string>`; `proxySourceLabels: Record<ProxySource, string>`; `interface ParsedProxy`; `type ProxyLineResult`; `parseProxyLine(raw: string, defaultType: ProxyType): ProxyLineResult`; `proxyEndpointKey(p: { type: ProxyType; host: string; port: number; username?: string | null }): string`; `interface ProxyListResult`; `parseProxyList(text: string, defaultType: ProxyType): ProxyListResult`; `proxyAccountRef`; `proxyDto`; `type ProxyDto`; `createProxyInput`; `type CreateProxyInput`; `updateProxyInput`; `type UpdateProxyInput`; `importProxiesInput`; `type ImportProxiesInput`; `importProxiesPreview`; `type ImportProxiesPreview`; `importProxiesResult`; `type ImportProxiesResult`

- [ ] **Шаг 1: Написать падающий тест**

`packages/shared/test/accounts.test.ts` — новый файл

```ts
import { describe, expect, it } from 'vitest'
import { accountTitle, confirmImportInput } from '../src/accounts.ts'
import { appEventSchema } from '../src/events.ts'

describe('accountTitle', () => {
  it('prefers label, then phone, then @username, then the Telegram id', () => {
    expect(accountTitle({ label: 'Основной', phone: '77001234567' })).toBe('Основной')
    expect(accountTitle({ phone: '77001234567', username: 'nox' })).toBe('+77001234567')
    expect(accountTitle({ username: 'nox', tgUserId: 1 })).toBe('@nox')
    expect(accountTitle({ tgUserId: 42 })).toBe('id 42')
  })
})

it('confirmImportInput requires a proxy id only for the "proxy" decision', () => {
  const id = '00000000-0000-4000-8000-000000000001'
  expect(confirmImportInput.safeParse({ items: [{ id, decision: 'proxy' }] }).success).toBe(false)
  expect(confirmImportInput.safeParse({ items: [{ id, decision: 'auto' }, { id, decision: 'skip' }] }).success).toBe(true)
})

it('app events carry new codes and QR progress', () => {
  expect(appEventSchema.parse({ type: 'code.new', id: 1, accountId: 'a', code: '575571', date: '2026-10-03T00:00:00.000Z' })).toMatchObject({ code: '575571' })
  expect(appEventSchema.safeParse({ type: 'qr.update', qrId: 'q', state: 'nope' }).success).toBe(false)
})
```

`packages/shared/test/proxies.test.ts` — новый файл

```ts
import { describe, expect, it } from 'vitest'
import { parseProxyLine, parseProxyList, proxyEndpointKey } from '../src/proxies.ts'

describe('parseProxyLine', () => {
  it.each([
    ['socks5://user:pass@1.2.3.4:1080', { type: 'socks5', host: '1.2.3.4', port: 1080, username: 'user', password: 'pass' }],
    ['socks://1.2.3.4:1080', { type: 'socks5', host: '1.2.3.4', port: 1080 }],
    ['http://u:p@proxy.example.com:3128', { type: 'http', host: 'proxy.example.com', port: 3128, username: 'u', password: 'p' }],
    ['1.2.3.4:8080', { type: 'http', host: '1.2.3.4', port: 8080 }],
    ['1.2.3.4:8080:user:p@ss:word', { type: 'http', host: '1.2.3.4', port: 8080, username: 'user', password: 'p@ss:word' }],
    ['user:pass@1.2.3.4:8080', { type: 'http', host: '1.2.3.4', port: 8080, username: 'user', password: 'pass' }],
    ['  http://1.2.3.4:80  ', { type: 'http', host: '1.2.3.4', port: 80 }],
  ])('%s', (line, expected) => {
    expect(parseProxyLine(line, 'http')).toEqual({ ok: true, proxy: expected })
  })

  it('uses the default type only for lines without a scheme', () => {
    expect(parseProxyLine('1.2.3.4:1080', 'socks5')).toEqual({ ok: true, proxy: { type: 'socks5', host: '1.2.3.4', port: 1080 } })
    expect(parseProxyLine('http://1.2.3.4:1080', 'socks5')).toMatchObject({ ok: true, proxy: { type: 'http' } })
  })

  it.each([
    ['ftp://1.2.3.4:21', 'Неизвестная схема ftp — нужна socks5 или http'],
    ['1.2.3.4', 'Ожидается host:port'],
    ['1.2.3.4:0', 'Порт — число от 1 до 65535'],
    ['1.2.3.4:99999', 'Порт — число от 1 до 65535'],
    ['bad host:80', 'Некорректный адрес'],
    ['1.2.3.4:80:user', 'Ожидается host:port:логин:пароль'],
  ])('rejects %s', (line, reason) => {
    expect(parseProxyLine(line, 'http')).toEqual({ ok: false, reason })
  })
})

describe('parseProxyList', () => {
  it('skips blanks and comments, reports errors with line numbers and repeated lines', () => {
    const text = ['# kz pool', 'socks5://u:p@1.1.1.1:1080', '', 'nonsense', '1.1.1.2:3128', 'socks5://u:p@1.1.1.1:1080'].join('\n')
    const result = parseProxyList(text, 'http')
    expect(result.proxies.map((p) => p.line)).toEqual([2, 5])
    expect(result.errors).toEqual([{ line: 4, text: 'nonsense', reason: 'Ожидается host:port' }])
    expect(result.repeated).toEqual([{ line: 6, text: 'socks5://u:p@1.1.1.1:1080' }])
  })

  it('treats the same endpoint with another password as a repeat', () => {
    const result = parseProxyList('1.1.1.1:80:u:a\n1.1.1.1:80:u:b', 'http')
    expect(result.proxies).toHaveLength(1)
    expect(result.repeated).toHaveLength(1)
  })
})

it('proxyEndpointKey identifies type, host, port and login', () => {
  expect(proxyEndpointKey({ type: 'http', host: 'A.example.com', port: 80, username: 'u' })).toBe('http://u@a.example.com:80')
  expect(proxyEndpointKey({ type: 'socks5', host: '1.1.1.1', port: 1080 })).toBe('socks5://1.1.1.1:1080')
})
```

- [ ] **Шаг 2: Убедиться, что тест падает**

```bash
fnm exec --using=26 npx vitest run --project shared packages/shared/test/proxies.test.ts packages/shared/test/accounts.test.ts
# FAIL: Cannot find module '../src/proxies.ts'
```

- [ ] **Шаг 3: Реализация**

`packages/shared/package.json` — изменения

```diff
--- a/packages/shared/package.json
+++ b/packages/shared/package.json
@@ -9,7 +9,10 @@
     "./crypto": "./src/crypto.ts",
     "./api": "./src/api.ts",
     "./events": "./src/events.ts",
-    "./settings": "./src/settings/index.ts"
+    "./settings": "./src/settings/index.ts",
+    "./proxies": "./src/proxies.ts",
+    "./accounts": "./src/accounts.ts",
+    "./commands": "./src/commands.ts"
   },
   "scripts": {
     "typecheck": "tsc -p tsconfig.json",
```

`packages/shared/src/accounts.ts` — новый файл

```ts
import { z } from 'zod'
import { PROXY_STATUSES, PROXY_TYPES } from './proxies.ts'

export const ACCOUNT_STATUSES = ['pending_check', 'active', 'paused', 'proxy_down', 'unauthorized', 'banned', 'frozen', 'error'] as const
export type AccountStatus = (typeof ACCOUNT_STATUSES)[number]

export const accountStatusLabels: Record<AccountStatus, string> = {
  pending_check: 'проверка',
  active: 'активен',
  paused: 'на паузе',
  proxy_down: 'прокси недоступен',
  unauthorized: 'сессия отозвана',
  banned: 'забанен',
  frozen: 'заморожен',
  error: 'ошибка',
}

/** Statuses in which the worker keeps (or tries to keep) a live client. */
export const RUNNING_STATUSES: readonly AccountStatus[] = ['pending_check', 'active', 'frozen', 'error']
/** Terminal statuses: the session is gone, only deletion makes sense. */
export const FINAL_STATUSES: readonly AccountStatus[] = ['unauthorized', 'banned']

export const ACCOUNT_SOURCES = ['tdata', 'qr'] as const
export const CLIENT_PROFILES = ['desktop', 'own'] as const
export const CONNECTION_MODES = ['proxy', 'direct'] as const

/** Codes are read only from this official service account (Telegram Gateway). */
export const CODE_SOURCE_USERNAME = 'VerificationCodes'

export const accountDeviceDto = z.object({ deviceModel: z.string(), systemVersion: z.string(), appVersion: z.string(), langCode: z.string() })

export const accountProxyRef = z.object({
  id: z.string(),
  type: z.enum(PROXY_TYPES),
  host: z.string(),
  port: z.number(),
  status: z.enum(PROXY_STATUSES),
  tgCountry: z.string().nullable(),
})

export const accountDto = z.object({
  id: z.string(),
  tgUserId: z.number(),
  phone: z.string().nullable(),
  username: z.string().nullable(),
  firstName: z.string().nullable(),
  lastName: z.string().nullable(),
  isPremium: z.boolean(),
  dcId: z.number().nullable(),
  label: z.string().nullable(),
  note: z.string().nullable(),
  source: z.enum(ACCOUNT_SOURCES),
  clientProfile: z.enum(CLIENT_PROFILES),
  device: accountDeviceDto,
  connectionMode: z.enum(CONNECTION_MODES),
  proxy: accountProxyRef.nullable(),
  status: z.enum(ACCOUNT_STATUSES),
  statusReason: z.string().nullable(),
  statusChangedAt: z.string(),
  lastOkAt: z.string().nullable(),
  frozenUntil: z.string().nullable(),
  lastCodeAt: z.string().nullable(),
  createdAt: z.string(),
})
export type AccountDto = z.output<typeof accountDto>

export const updateAccountInput = z.object({
  label: z.string().trim().max(64).nullable().optional(),
  note: z.string().trim().max(2000).nullable().optional(),
})
export type UpdateAccountInput = z.output<typeof updateAccountInput>

/** `proxyId: null` = connect directly (only by an explicit decision). */
export const setAccountProxyInput = z.object({ proxyId: z.string().uuid().nullable() })
export type SetAccountProxyInput = z.output<typeof setAccountProxyInput>

export const deleteAccountQuery = z.object({ logout: z.stringbool().default(false) })

/** One active session of an account (account.getAuthorizations). */
export const accountSessionDto = z.object({
  hash: z.string(),
  current: z.boolean(),
  official: z.boolean(),
  appName: z.string(),
  appVersion: z.string(),
  deviceModel: z.string(),
  platform: z.string(),
  systemVersion: z.string(),
  ip: z.string(),
  country: z.string(),
  region: z.string(),
  createdAt: z.string(),
  activeAt: z.string(),
})
export type AccountSessionDto = z.output<typeof accountSessionDto>

// ---- tdata import ----

export const importItemDto = z.object({
  id: z.string(),
  pathInArchive: z.string(),
  accountIndex: z.number(),
  tgUserId: z.number(),
  dcId: z.number(),
  duplicateOf: z.object({ id: z.string(), label: z.string().nullable(), phone: z.string().nullable() }).nullable(),
  decision: z.enum(['pending', 'imported', 'skipped']),
  accountId: z.string().nullable(),
})
export type ImportItemDto = z.output<typeof importItemDto>

export const importBatchDto = z.object({
  id: z.string(),
  filename: z.string(),
  status: z.enum(['ready', 'confirmed']),
  createdAt: z.string(),
  expiresAt: z.string(),
  items: z.array(importItemDto),
})
export type ImportBatchDto = z.output<typeof importBatchDto>

export const confirmImportInput = z.object({
  items: z
    .array(
      z.discriminatedUnion('decision', [
        z.object({ id: z.string().uuid(), decision: z.literal('proxy'), proxyId: z.string().uuid() }),
        z.object({ id: z.string().uuid(), decision: z.literal('auto') }),
        z.object({ id: z.string().uuid(), decision: z.literal('direct') }),
        z.object({ id: z.string().uuid(), decision: z.literal('skip') }),
      ]),
    )
    .min(1),
})
export type ConfirmImportInput = z.output<typeof confirmImportInput>

export const confirmImportResult = z.object({ created: z.number(), skipped: z.number() })
export type ConfirmImportResult = z.output<typeof confirmImportResult>

// ---- codes ----

export const codeDto = z.object({
  id: z.number(),
  accountId: z.string(),
  account: z.object({ label: z.string().nullable(), phone: z.string().nullable(), username: z.string().nullable() }),
  tgMessageId: z.number(),
  date: z.string(),
  text: z.string(),
  code: z.string().nullable(),
  notifiedAt: z.string().nullable(),
})
export type CodeDto = z.output<typeof codeDto>

export const codesQuery = z.object({
  accountId: z.string().uuid().optional(),
  /** id of the oldest code already shown — returns older ones */
  before: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
})
export type CodesQuery = z.output<typeof codesQuery>

// ---- QR login ----

export const startQrInput = z.object({ proxyId: z.string().uuid().nullable() })
export type StartQrInput = z.output<typeof startQrInput>

export const qrPasswordInput = z.object({ password: z.string().min(1).max(256) })

export const QR_STATES = ['waiting', 'scanned', 'password_needed', 'password_invalid', 'done', 'failed', 'expired', 'cancelled'] as const
export type QrState = (typeof QR_STATES)[number]

/** Shown under an account label when there is no label: phone, @username or Telegram id. */
export function accountTitle(a: { label?: string | null; phone?: string | null; username?: string | null; tgUserId?: number | null }): string {
  if (a.label) return a.label
  if (a.phone) return `+${a.phone.replace(/^\+/, '')}`
  if (a.username) return `@${a.username}`
  return a.tgUserId ? `id ${a.tgUserId}` : 'аккаунт'
}
```

`packages/shared/src/commands.ts` — новый файл

```ts
import { z } from 'zod'

/** BullMQ queue the api uses to ask the worker to act on accounts and proxies. */
export const COMMANDS_QUEUE = 'worker-commands'

export const workerCommandSchema = z.discriminatedUnion('type', [
  /** (re)load the account from the database and run it if its status says so */
  z.object({ type: z.literal('account.sync'), accountId: z.string() }),
  /** disconnect and forget the client (pause, delete, proxy change); `logout` ends the Telegram session first */
  z.object({ type: z.literal('account.stop'), accountId: z.string(), logout: z.boolean().default(false) }),
  z.object({ type: z.literal('account.sessions'), accountId: z.string() }),
  z.object({ type: z.literal('account.terminateSession'), accountId: z.string(), hash: z.string().regex(/^-?\d+$/) }),
  z.object({ type: z.literal('proxy.check'), proxyId: z.string() }),
  z.object({ type: z.literal('proxy.sync') }),
  z.object({ type: z.literal('qr.start'), qrId: z.string(), proxyId: z.string().nullable(), adminId: z.string().nullable() }),
])

export type WorkerCommand = z.output<typeof workerCommandSchema>
export type WorkerCommandType = WorkerCommand['type']

/** Redis pub/sub channel carrying the 2FA password (or a cancel) to a running QR login; never stored. */
export const qrControlChannel = (qrId: string) => `accs:qr:${qrId}`
export const qrControlSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('password'), password: z.string() }),
  z.object({ type: z.literal('cancel') }),
])
export type QrControl = z.output<typeof qrControlSchema>
```

`packages/shared/src/events.ts` — изменения

```diff
--- a/packages/shared/src/events.ts
+++ b/packages/shared/src/events.ts
@@ -1,4 +1,5 @@
 import { z } from 'zod'
+import { QR_STATES } from './accounts.ts'
 
 /** Redis pub/sub channel shared by api and worker; also the source of the SSE stream. */
 export const EVENTS_CHANNEL = 'accs:events'
@@ -10,6 +11,28 @@ export const appEventSchema = z.discriminatedUnion('type', [
     /** admin id, or null for CLI/system */
     by: z.string().nullable(),
   }),
+  /** proxies added, removed, checked or synced — the UI refetches */
+  z.object({ type: z.literal('proxies.changed'), ids: z.array(z.string()) }),
+  /** account status, profile or proxy changed — the UI refetches */
+  z.object({ type: z.literal('accounts.changed'), ids: z.array(z.string()) }),
+  z.object({
+    type: z.literal('code.new'),
+    id: z.number(),
+    accountId: z.string(),
+    code: z.string().nullable(),
+    date: z.string(),
+  }),
+  /** progress of a QR login started in the panel */
+  z.object({
+    type: z.literal('qr.update'),
+    qrId: z.string(),
+    state: z.enum(QR_STATES),
+    url: z.string().optional(),
+    expiresAt: z.string().optional(),
+    hint: z.string().optional(),
+    accountId: z.string().optional(),
+    message: z.string().optional(),
+  }),
 ])
 
 export type AppEvent = z.output<typeof appEventSchema>
```

`packages/shared/src/proxies.ts` — новый файл

```ts
import { z } from 'zod'

export const PROXY_TYPES = ['socks5', 'http'] as const
export type ProxyType = (typeof PROXY_TYPES)[number]

export const PROXY_SOURCES = ['manual', 'proxy_store'] as const
export type ProxySource = (typeof PROXY_SOURCES)[number]

export const PROXY_STATUSES = ['provisioning', 'unchecked', 'ok', 'failing', 'dead', 'expired'] as const
export type ProxyStatus = (typeof PROXY_STATUSES)[number]

export const proxyStatusLabels: Record<ProxyStatus, string> = {
  provisioning: 'выдаётся',
  unchecked: 'не проверен',
  ok: 'работает',
  failing: 'сбоит',
  dead: 'не работает',
  expired: 'истёк',
}

export const proxySourceLabels: Record<ProxySource, string> = { manual: 'вручную', proxy_store: 'proxy-store' }

// ---- parsing proxy lists ----

export interface ParsedProxy {
  type: ProxyType
  host: string
  port: number
  username?: string
  password?: string
}

export type ProxyLineResult = { ok: true; proxy: ParsedProxy } | { ok: false; reason: string }

const SCHEMES: Record<string, ProxyType> = { socks5: 'socks5', socks5h: 'socks5', socks: 'socks5', http: 'http' }
const HOST_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i

const fail = (reason: string): ProxyLineResult => ({ ok: false, reason })

function parseHostPort(value: string): { host: string; port: number } | string {
  const match = /^(.+):(\d+)$/.exec(value)
  if (!match) return 'Ожидается host:port'
  const port = Number(match[2])
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return 'Порт — число от 1 до 65535'
  const host = match[1]!.toLowerCase()
  if (!HOST_RE.test(host)) return 'Некорректный адрес'
  return { host, port }
}

function withCredentials(type: ProxyType, hostPort: string, username: string, password: string): ProxyLineResult {
  const endpoint = parseHostPort(hostPort)
  if (typeof endpoint === 'string') return fail(endpoint)
  return { ok: true, proxy: { type, ...endpoint, ...(username ? { username } : {}), ...(password ? { password } : {}) } }
}

/**
 * One proxy per line in any of: `socks5://user:pass@host:port`, `http://host:port`, `host:port`,
 * `host:port:user:pass`, `user:pass@host:port`. Lines without a scheme get `defaultType`.
 */
export function parseProxyLine(raw: string, defaultType: ProxyType): ProxyLineResult {
  const line = raw.trim()
  const scheme = /^([a-z0-9]+):\/\//i.exec(line)
  if (scheme) {
    const name = scheme[1]!.toLowerCase()
    const type = SCHEMES[name]
    if (!type) return fail(`Неизвестная схема ${name} — нужна socks5 или http`)
    const rest = line.slice(scheme[0].length)
    const at = rest.lastIndexOf('@')
    if (at < 0) return withCredentials(type, rest, '', '')
    const creds = rest.slice(0, at)
    const colon = creds.indexOf(':')
    return withCredentials(type, rest.slice(at + 1), colon < 0 ? creds : creds.slice(0, colon), colon < 0 ? '' : creds.slice(colon + 1))
  }
  // host:port:user:pass — checked first: the password may itself contain '@' or ':'
  const hostPortCreds = /^([^:@\s]+):(\d+):(.*)$/.exec(line)
  if (hostPortCreds) {
    const creds = hostPortCreds[3]!
    const colon = creds.indexOf(':')
    if (colon <= 0) return fail('Ожидается host:port:логин:пароль')
    return withCredentials(defaultType, `${hostPortCreds[1]}:${hostPortCreds[2]}`, creds.slice(0, colon), creds.slice(colon + 1))
  }
  const at = line.lastIndexOf('@')
  if (at >= 0) {
    const creds = line.slice(0, at)
    const colon = creds.indexOf(':')
    return withCredentials(defaultType, line.slice(at + 1), colon < 0 ? creds : creds.slice(0, colon), colon < 0 ? '' : creds.slice(colon + 1))
  }
  return withCredentials(defaultType, line, '', '')
}

/** Identity of a proxy in the pool: type, host, port and login (the password is not part of it). */
export function proxyEndpointKey(p: { type: ProxyType; host: string; port: number; username?: string | null }): string {
  return `${p.type}://${p.username ? `${p.username}@` : ''}${p.host.toLowerCase()}:${p.port}`
}

export interface ProxyListResult {
  proxies: (ParsedProxy & { line: number })[]
  errors: { line: number; text: string; reason: string }[]
  /** the same endpoint earlier in the list */
  repeated: { line: number; text: string }[]
}

/** Parses a pasted list or .txt file: blank lines and `#` comments are skipped. */
export function parseProxyList(text: string, defaultType: ProxyType): ProxyListResult {
  const result: ProxyListResult = { proxies: [], errors: [], repeated: [] }
  const seen = new Set<string>()
  text.split(/\r?\n/).forEach((raw, index) => {
    const line = index + 1
    const trimmed = raw.trim()
    if (!trimmed || trimmed.startsWith('#')) return
    const parsed = parseProxyLine(trimmed, defaultType)
    if (!parsed.ok) {
      result.errors.push({ line, text: trimmed, reason: parsed.reason })
      return
    }
    const key = proxyEndpointKey(parsed.proxy)
    if (seen.has(key)) {
      result.repeated.push({ line, text: trimmed })
      return
    }
    seen.add(key)
    result.proxies.push({ ...parsed.proxy, line })
  })
  return result
}

// ---- API ----

export const proxyAccountRef = z.object({ id: z.string(), label: z.string().nullable(), phone: z.string().nullable(), username: z.string().nullable() })

export const proxyDto = z.object({
  id: z.string(),
  source: z.enum(PROXY_SOURCES),
  externalId: z.string().nullable(),
  type: z.enum(PROXY_TYPES),
  host: z.string(),
  port: z.number(),
  username: z.string().nullable(),
  /** the password itself is never returned */
  hasPassword: z.boolean(),
  tag: z.string().nullable(),
  status: z.enum(PROXY_STATUSES),
  lastCheckAt: z.string().nullable(),
  lastOkAt: z.string().nullable(),
  latencyMs: z.number().nullable(),
  tgCountry: z.string().nullable(),
  lastError: z.string().nullable(),
  failStreak: z.number(),
  expiresAt: z.string().nullable(),
  disabledAt: z.string().nullable(),
  createdAt: z.string(),
  account: proxyAccountRef.nullable(),
})
export type ProxyDto = z.output<typeof proxyDto>

const hostSchema = z.string().trim().toLowerCase().regex(HOST_RE, 'Некорректный адрес')
const tagSchema = z.string().trim().max(64).nullable().optional()

export const createProxyInput = z.object({
  type: z.enum(PROXY_TYPES),
  host: hostSchema,
  port: z.coerce.number().int().min(1, 'Порт — число от 1 до 65535').max(65_535, 'Порт — число от 1 до 65535'),
  username: z.string().trim().max(256).optional(),
  password: z.string().max(256).optional(),
  tag: tagSchema,
})
export type CreateProxyInput = z.output<typeof createProxyInput>

export const updateProxyInput = z.object({ tag: tagSchema, disabled: z.boolean().optional() })
export type UpdateProxyInput = z.output<typeof updateProxyInput>

export const importProxiesInput = z.object({
  text: z.string().max(1_000_000),
  defaultType: z.enum(PROXY_TYPES),
  tag: tagSchema,
})
export type ImportProxiesInput = z.output<typeof importProxiesInput>

export const importProxiesPreview = z.object({
  /** new endpoints, without passwords */
  proxies: z.array(z.object({ line: z.number(), type: z.enum(PROXY_TYPES), host: z.string(), port: z.number(), username: z.string().nullable() })),
  errors: z.array(z.object({ line: z.number(), text: z.string(), reason: z.string() })),
  /** repeated in the list or already in the pool */
  duplicates: z.array(z.object({ line: z.number(), text: z.string(), reason: z.enum(['repeated', 'exists']) })),
})
export type ImportProxiesPreview = z.output<typeof importProxiesPreview>

export const importProxiesResult = z.object({ created: z.number(), skipped: z.number() })
export type ImportProxiesResult = z.output<typeof importProxiesResult>
```

- [ ] **Шаг 4: Проверки**

```bash
fnm exec --using=26 pnpm typecheck
fnm exec --using=26 pnpm lint
fnm exec --using=26 npx vitest run --project shared
# всё зелёное
```

- [ ] **Шаг 5: Коммит**

```bash
git add -A
git commit -F - <<'MSG'
feat(shared): proxy list parser, proxy/account/import/code DTOs, worker commands, new live events
MSG
```

---

### Task 3: `server`: очередь команд воркеру

API говорит с воркером через BullMQ-очередь `worker-commands`: `send` — «сделай» без ответа, `call` — ждёт результат задачи с таймаутом (`WorkerTimeoutError`). BullMQ требует от соединения `maxRetriesPerRequest: null` — `createRedis` получает опцию `forQueues`. Нативный `msgpackr-extract` (необязательное ускорение BullMQ) запрещён в `allowBuilds`, работает JS-фолбэк.

**Files:**
- Modify: `packages/server/package.json`
- Modify: `packages/server/src/index.ts`
- Create: `packages/server/src/queues.ts`
- Modify: `packages/server/src/redis.ts`
- Test: `packages/server/test/queues.test.ts`
- Modify: `pnpm-workspace.yaml`
- Generated: `pnpm-lock.yaml` — не писать руками (команды ниже)

**Interfaces:**
- Consumes: `createRedis`, `createLogger` из `packages/server` (план 1); `workerCommandSchema` (задача 2).
- Produces:
  - `packages/server/src/queues.ts`: `QUEUE_PREFIX`; `class WorkerTimeoutError`; `interface CommandClient`; `createCommandClient(connection: Redis, prefix = QUEUE_PREFIX): CommandClient`
  - `packages/server/src/redis.ts`: `createRedis(url: string, name: string, logger?: Logger, options: { forQueues?: boolean } = {}): Redis`

- [ ] **Шаг 1: Зависимости**

```bash
fnm exec --using=26 pnpm --filter @workspace/server add 'bullmq@^6'
# pnpm-workspace.yaml: msgpackr-extract: false в allowBuilds — дифф ниже
```

- [ ] **Шаг 2: Написать падающий тест**

`packages/server/test/queues.test.ts` — новый файл

```ts
import { randomUUID } from 'node:crypto'
import type {} from '@workspace/db/testing'
import { Worker } from 'bullmq'
import { afterAll, describe, expect, inject, it } from 'vitest'
import { COMMANDS_QUEUE, createCommandClient, WorkerTimeoutError } from '../src/queues.ts'
import { createRedis } from '../src/redis.ts'

const url = inject('redisUrl')
const conn = createRedis(url, 'queues-test', undefined, { forQueues: true })
// other test files share this Redis: a prefix of our own keeps their workers off our jobs
const prefix = `test-${randomUUID()}`
afterAll(async () => {
  await conn.quit()
})

describe('worker commands', () => {
  it('sends a command and returns the worker answer', async () => {
    const client = createCommandClient(conn, prefix)
    const worker = new Worker(
      COMMANDS_QUEUE,
      async (job) => (job.data.type === 'account.sessions' ? [{ hash: '1', current: true }] : null),
      { connection: conn.duplicate(), prefix },
    )
    try {
      await expect(client.call({ type: 'account.sessions', accountId: 'a' })).resolves.toEqual([{ hash: '1', current: true }])
    } finally {
      await worker.close()
      await client.close()
    }
  })

  it('rejects malformed commands before they reach the queue', async () => {
    const client = createCommandClient(conn, prefix)
    try {
      // the hash must be a decimal Telegram long
      await expect(client.send({ type: 'account.terminateSession', accountId: 'a', hash: 'abc' })).rejects.toThrow()
    } finally {
      await client.close()
    }
  })

  it('times out when no worker answers', async () => {
    const client = createCommandClient(conn, prefix)
    try {
      await expect(client.call({ type: 'proxy.sync' }, 300)).rejects.toBeInstanceOf(WorkerTimeoutError)
    } finally {
      await client.close()
    }
  })
})
```

- [ ] **Шаг 3: Убедиться, что тест падает**

```bash
fnm exec --using=26 npx vitest run --project server packages/server/test/queues.test.ts
# FAIL: Cannot find module '../src/queues.ts'
```

- [ ] **Шаг 4: Реализация**

`packages/server/package.json` — изменения

```diff
--- a/packages/server/package.json
+++ b/packages/server/package.json
@@ -13,6 +13,7 @@
   "dependencies": {
     "@workspace/db": "workspace:*",
     "@workspace/shared": "workspace:*",
+    "bullmq": "^6.3.11",
     "drizzle-orm": "^0.45.3",
     "ioredis": "^6.0.0",
     "pino": "^10.3.1",
```

`packages/server/src/index.ts` — изменения

```diff
--- a/packages/server/src/index.ts
+++ b/packages/server/src/index.ts
@@ -2,5 +2,6 @@ export * from './audit.ts'
 export * from './bus.ts'
 export * from './logger.ts'
 export * from './process.ts'
+export * from './queues.ts'
 export * from './redis.ts'
 export * from './settings-service.ts'
```

`packages/server/src/queues.ts` — новый файл

```ts
import { COMMANDS_QUEUE, workerCommandSchema, type WorkerCommand } from '@workspace/shared/commands'
import { Queue, QueueEvents, type Job } from 'bullmq'
import type { Redis } from './redis.ts'

export { COMMANDS_QUEUE }

/** All queues of the project live under this Redis key prefix. */
export const QUEUE_PREFIX = 'accs'

/** Command jobs keep nothing after they finish: payloads may name accounts and sessions. */
const COMMAND_JOB_OPTIONS = { removeOnComplete: true, removeOnFail: true, attempts: 1 } as const

export class WorkerTimeoutError extends Error {
  constructor(type: string) {
    super(`worker did not answer "${type}" in time`)
    this.name = 'WorkerTimeoutError'
  }
}

export interface CommandClient {
  /** fire and forget: the worker picks it up when it can */
  send(command: WorkerCommand): Promise<void>
  /** waits for the worker's answer; throws WorkerTimeoutError when it does not come in `timeoutMs` */
  call<T = unknown>(command: WorkerCommand, timeoutMs?: number): Promise<T>
  close(): Promise<void>
}

/**
 * The api side of the worker commands queue. `connection` must be created with `forQueues`;
 * `prefix` exists for tests that share one Redis.
 */
export function createCommandClient(connection: Redis, prefix = QUEUE_PREFIX): CommandClient {
  const queue = new Queue<WorkerCommand>(COMMANDS_QUEUE, { connection, prefix })
  // QueueEvents blocks on XREAD, so it needs its own connection
  const events = new QueueEvents(COMMANDS_QUEUE, { connection: connection.duplicate(), prefix })
  const ready = events.waitUntilReady()

  const add = (command: WorkerCommand): Promise<Job<WorkerCommand>> =>
    queue.add(command.type, workerCommandSchema.parse(command), COMMAND_JOB_OPTIONS)

  return {
    async send(command) {
      await add(command)
    },
    async call<T>(command: WorkerCommand, timeoutMs = 15_000): Promise<T> {
      await ready
      const job = await add(command)
      try {
        return (await job.waitUntilFinished(events, timeoutMs)) as T
      } catch (err) {
        if (err instanceof Error && /timed out/i.test(err.message)) {
          await job.remove().catch(() => {})
          throw new WorkerTimeoutError(command.type)
        }
        throw err
      }
    },
    async close() {
      await events.close()
      await queue.close()
    },
  }
}
```

`packages/server/src/redis.ts` — изменения

```diff
--- a/packages/server/src/redis.ts
+++ b/packages/server/src/redis.ts
@@ -5,10 +5,11 @@ export type { Redis }
 
 /**
  * `name` shows up in `CLIENT LIST`. An 'error' listener is always attached: without one ioredis
- * prints "Unhandled error event" on every reconnect attempt.
+ * prints "Unhandled error event" on every reconnect attempt. BullMQ needs `forQueues` connections:
+ * its blocking commands must wait for a reconnect instead of failing after a few retries.
  */
-export function createRedis(url: string, name: string, logger?: Logger): Redis {
-  const redis = new Redis(url, { connectionName: name })
+export function createRedis(url: string, name: string, logger?: Logger, options: { forQueues?: boolean } = {}): Redis {
+  const redis = new Redis(url, { connectionName: name, ...(options.forQueues ? { maxRetriesPerRequest: null } : {}) })
   redis.on('error', (err: Error) => logger?.warn({ err, connection: name }, 'redis: connection error'))
   return redis
 }
```

`pnpm-workspace.yaml` — изменения

```diff
--- a/pnpm-workspace.yaml
+++ b/pnpm-workspace.yaml
@@ -10,3 +10,5 @@ allowBuilds:
   cpu-features: false
   ssh2: false
   protobufjs: false
+  # optional native msgpack speedup of bullmq; the pure-JS fallback is used
+  msgpackr-extract: false
```

- [ ] **Шаг 5: Проверки**

```bash
fnm exec --using=26 pnpm typecheck
fnm exec --using=26 pnpm lint
fnm exec --using=26 npx vitest run --project server
# всё зелёное
```

- [ ] **Шаг 6: Коммит**

```bash
git add -A
git commit -F - <<'MSG'
feat(server): worker command queue (BullMQ) with send/call and timeouts; queue-safe redis connections
MSG
```

---

### Task 4: Процесс воркера: lock, очереди, heartbeat

Новое приложение `apps/worker`. Единственность — `pg_advisory_lock` на отдельном соединении: второй экземпляр ждёт, потеря соединения с lock — выход процесса (о потере сообщается один раз, на мёртвом соединении запросов нет). Runtime поднимает обработчик команд и периодические задачи (`MAINTENANCE_TASKS`: `proxies.checkDue` каждые 60 с, `proxies.sync`, `accounts.refreshProfiles`, `housekeeping` раз в час) через BullMQ job schedulers и перепланирует их при смене интервалов в настройках. Heartbeat в Redis (`accs:worker:heartbeat`, TTL 60 с) — `/api/healthz` отдаёт `worker: ok|down`, но здоровье API от воркера не зависит. Сервис `accs-worker` — тот же образ, `node apps/worker/src/main.ts`, без портов, `stop_grace_period: 30s`, healthcheck образа выключен. Ключи Redis и префикс очередей в тестах уникальные — тесты не мешают друг другу на общем Redis.

**Files:**
- Create: `packages/server/src/heartbeat.ts`
- Modify: `packages/server/src/index.ts`
- Modify: `apps/api/src/routes/health.ts`
- Test (modify): `apps/api/test/app.test.ts`
- Create: `apps/worker/package.json`
- Create: `apps/worker/src/deps.ts`
- Create: `apps/worker/src/lock.ts`
- Create: `apps/worker/src/main.ts`
- Create: `apps/worker/src/runtime.ts`
- Create: `apps/worker/src/schedule.ts`
- Test: `apps/worker/test/helpers.ts`
- Test: `apps/worker/test/runtime.test.ts`
- Create: `apps/worker/tsconfig.json`
- Modify: `Dockerfile`
- Modify: `compose.prod.yml`
- Modify: `compose.yml`
- Modify: `vitest.config.ts`
- Generated: `pnpm-lock.yaml` — не писать руками (команды ниже)

**Interfaces:**
- Consumes: `createCommandClient`, `QUEUE_PREFIX` (задача 3); `SettingsService`, `createEventBus`, `exitOnFatalErrors` (план 1).
- Produces:
  - `packages/server/src/heartbeat.ts`: `HEARTBEAT_KEY`; `interface Heartbeat`; `startWorkerHeartbeat(redis: Redis, version: string, options: { intervalMs?: number; key?: string } = {}): () => Promise<void>`; `readWorkerHeartbeat(redis: Redis, key = HEARTBEAT_KEY): Promise<Heartbeat | null>`
  - `apps/worker/src/deps.ts`: `interface WorkerDeps`
  - `apps/worker/src/lock.ts`: `WORKER_LOCK_KEY`; `interface SingletonLock`; `interface LockOptions`; `acquireSingletonLock(pool: pg.Pool, options: LockOptions): Promise<SingletonLock>`
  - `apps/worker/src/runtime.ts`: `type CommandHandlers`; `type MaintenanceHandlers`; `interface WorkerRuntime`; `createWorkerRuntime(`
  - `apps/worker/src/schedule.ts`: `MAINTENANCE_QUEUE`; `MAINTENANCE_TASKS`; `type MaintenanceTask`; `SCHEDULE_SETTINGS: readonly SettingKey[]`; `schedulePlan(settings: Pick<SettingsService, 'get'>): Record<MaintenanceTask, number>`

- [ ] **Шаг 1: Зависимости**

```bash
# apps/worker/package.json — новый файл (ниже), затем:
fnm exec --using=26 pnpm install
```

- [ ] **Шаг 2: Написать падающий тест**

`apps/api/test/app.test.ts` — изменения

```diff
--- a/apps/api/test/app.test.ts
+++ b/apps/api/test/app.test.ts
@@ -13,13 +13,22 @@ describe('app shell', () => {
   it('reports health of Postgres and Redis', async () => {
     const res = await send(ta.app, '/api/healthz')
     expect(res.status).toBe(200)
-    expect(await res.json()).toEqual({ ok: true, version: 'dev' })
+    expect(await res.json()).toEqual({ ok: true, version: 'dev', worker: 'down' })
+  })
+
+  it('reports the worker as up while its heartbeat is fresh', async () => {
+    await ta.deps.redis.set('accs:worker:heartbeat', JSON.stringify({ at: new Date().toISOString(), pid: 1, version: 'dev' }), 'PX', 5_000)
+    try {
+      expect(await (await send(ta.app, '/api/healthz')).json()).toMatchObject({ worker: 'ok' })
+    } finally {
+      await ta.deps.redis.del('accs:worker:heartbeat')
+    }
   })
 
   it('reports the deployed version baked into the image', async () => {
     const versioned = await setupApp({ APP_VERSION: 'abc1234' })
     try {
-      expect(await (await send(versioned.app, '/api/healthz')).json()).toEqual({ ok: true, version: 'abc1234' })
+      expect(await (await send(versioned.app, '/api/healthz')).json()).toMatchObject({ ok: true, version: 'abc1234' })
     } finally {
       await versioned.close()
     }
```

`apps/worker/test/helpers.ts` — новый файл

```ts
import { randomBytes, randomUUID } from 'node:crypto'
import { createTestDatabase, type TestDatabase } from '@workspace/db/testing'
import { createEventBus, createLogger, createRedis, SettingsService, type Redis } from '@workspace/server'
import { createCipher } from '@workspace/shared/crypto'
import { loadEnv } from '@workspace/shared/env'
import { inject } from 'vitest'
import type { WorkerDeps } from '../src/deps.ts'

export interface TestWorker {
  deps: WorkerDeps
  t: TestDatabase
  close(): Promise<void>
}

/** Worker dependencies on an isolated database, a private queue prefix and bus channel. */
export async function setupWorker(): Promise<TestWorker> {
  const t = await createTestDatabase(inject('pgAdminUrl'))
  const redisUrl = inject('redisUrl')
  const redis: Redis = createRedis(redisUrl, 'test-worker')
  const sub: Redis = createRedis(redisUrl, 'test-worker-sub')
  const queueRedis: Redis = createRedis(redisUrl, 'test-worker-queues', undefined, { forQueues: true })
  const bus = await createEventBus({ publisher: redis, subscriber: sub, channel: `test:${randomUUID()}` })
  const env = loadEnv({
    DATABASE_URL: t.url,
    REDIS_URL: redisUrl,
    APP_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    PUBLIC_ORIGIN: 'http://localhost:5173',
    NODE_ENV: 'test',
  })
  const cipher = createCipher(env.APP_ENCRYPTION_KEY)
  const settings = await SettingsService.create({ db: t.db, cipher, bus })
  const deps: WorkerDeps = {
    env,
    db: t.db,
    pool: t.pool,
    redis,
    queueRedis,
    bus,
    settings,
    cipher,
    logger: createLogger({ level: 'silent' }),
    queuePrefix: `test-${randomUUID()}`,
  }
  return {
    deps,
    t,
    async close() {
      settings.close()
      await bus.close()
      await Promise.allSettled([redis.quit(), sub.quit(), queueRedis.quit()])
      await t.drop()
    },
  }
}
```

`apps/worker/test/runtime.test.ts` — новый файл

```ts
import { createCommandClient, readWorkerHeartbeat, startWorkerHeartbeat } from '@workspace/server'
import { Queue } from 'bullmq'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { acquireSingletonLock } from '../src/lock.ts'
import { createWorkerRuntime } from '../src/runtime.ts'
import { MAINTENANCE_QUEUE } from '../src/schedule.ts'
import { setupWorker, type TestWorker } from './helpers.ts'

let w: TestWorker
beforeAll(async () => {
  w = await setupWorker()
})
afterAll(async () => {
  await w.close()
})

describe('singleton lock', () => {
  it('lets a second worker wait until the first one releases', async () => {
    const onLost = vi.fn()
    const first = await acquireSingletonLock(w.deps.pool, { key: 'test:lock:a', onLost })
    const onWaiting = vi.fn()
    let secondAcquired = false
    const second = acquireSingletonLock(w.deps.pool, { key: 'test:lock:a', retryMs: 20, onWaiting, onLost }).then((lock) => {
      secondAcquired = true
      return lock
    })
    await vi.waitFor(() => expect(onWaiting).toHaveBeenCalledOnce())
    expect(secondAcquired).toBe(false)
    await first.release()
    await (await second).release()
    expect(onLost).not.toHaveBeenCalled()
  })

  it('reports a lost connection: the lock went with it', async () => {
    const onLost = vi.fn()
    const lock = await acquireSingletonLock(w.deps.pool, { key: 'test:lock:b', onLost })
    await w.deps.pool.query(
      `select pg_terminate_backend(pid) from pg_locks where locktype = 'advisory' and objid = hashtext('test:lock:b')::oid`,
    )
    await vi.waitFor(() => expect(onLost).toHaveBeenCalledOnce())
    await lock.release()
  })
})

it('heartbeat keeps a short-lived key and removes it on stop', async () => {
  // a key of our own: the api tests read the real one from the same Redis
  const key = `test:heartbeat:${w.deps.queuePrefix}`
  const stop = startWorkerHeartbeat(w.deps.redis, 'abc123', { intervalMs: 50, key })
  await vi.waitFor(async () => expect(await readWorkerHeartbeat(w.deps.redis, key)).toMatchObject({ version: 'abc123' }))
  expect(await w.deps.redis.pttl(key)).toBeGreaterThan(30_000)
  await stop()
  expect(await readWorkerHeartbeat(w.deps.redis, key)).toBeNull()
})

describe('runtime', () => {
  it('plans maintenance from settings and re-plans when they change', async () => {
    const runtime = createWorkerRuntime(w.deps, { commands: {}, maintenance: {} })
    await runtime.start()
    const queue = new Queue(MAINTENANCE_QUEUE, { connection: w.deps.queueRedis, prefix: w.deps.queuePrefix })
    try {
      const every = async () => Object.fromEntries((await queue.getJobSchedulers()).map((s) => [s.key, Number(s.every)]))
      expect(await every()).toEqual({
        'proxies.checkDue': 60_000,
        'proxies.sync': 15 * 60_000,
        'accounts.refreshProfiles': 6 * 3_600_000,
        housekeeping: 3_600_000,
      })
      await w.deps.settings.update({ 'proxyStore.syncInterval': '5m' }, { adminId: null })
      await vi.waitFor(async () => expect((await every())['proxies.sync']).toBe(5 * 60_000))
    } finally {
      await queue.close()
      await runtime.stop()
    }
  })

  it('routes commands to their handlers and answers through BullMQ', async () => {
    const sessions = vi.fn(async ({ accountId }: { accountId: string }) => [{ hash: '1', accountId }])
    const runtime = createWorkerRuntime(w.deps, { commands: { 'account.sessions': sessions }, maintenance: {} })
    await runtime.start()
    const client = createCommandClient(w.deps.queueRedis, w.deps.queuePrefix)
    try {
      await expect(client.call({ type: 'account.sessions', accountId: 'acc-1' })).resolves.toEqual([{ hash: '1', accountId: 'acc-1' }])
      // a command without a handler fails instead of hanging
      await expect(client.call({ type: 'proxy.sync' }, 5_000)).rejects.toThrow(/no handler for proxy.sync/)
    } finally {
      await client.close()
      await runtime.stop()
    }
  })
})
```

- [ ] **Шаг 3: Убедиться, что тест падает**

```bash
fnm exec --using=26 npx vitest run --project worker
# FAIL: проект worker не найден / нет модулей ../src/runtime.ts, ../src/lock.ts
```

- [ ] **Шаг 4: Реализация**

`packages/server/src/heartbeat.ts` — новый файл

```ts
import type { Redis } from './redis.ts'

/** The worker refreshes this key; the api reads it to show whether the worker is alive. */
export const HEARTBEAT_KEY = 'accs:worker:heartbeat'
const TTL_MS = 60_000

export interface Heartbeat {
  at: string
  pid: number
  version: string
}

/** `key` is for tests that share one Redis. */
export function startWorkerHeartbeat(redis: Redis, version: string, options: { intervalMs?: number; key?: string } = {}): () => Promise<void> {
  const key = options.key ?? HEARTBEAT_KEY
  const beat = () => {
    const value: Heartbeat = { at: new Date().toISOString(), pid: process.pid, version }
    redis.set(key, JSON.stringify(value), 'PX', TTL_MS).catch(() => {})
  }
  beat()
  const timer = setInterval(beat, options.intervalMs ?? 15_000)
  timer.unref()
  return async () => {
    clearInterval(timer)
    await redis.del(key).catch(() => {})
  }
}

/** The last heartbeat, or null when the worker has not reported for a minute. */
export async function readWorkerHeartbeat(redis: Redis, key = HEARTBEAT_KEY): Promise<Heartbeat | null> {
  const raw = await redis.get(key)
  if (!raw) return null
  try {
    return JSON.parse(raw) as Heartbeat
  } catch {
    return null
  }
}
```

`packages/server/src/index.ts` — изменения

```diff
--- a/packages/server/src/index.ts
+++ b/packages/server/src/index.ts
@@ -1,5 +1,6 @@
 export * from './audit.ts'
 export * from './bus.ts'
+export * from './heartbeat.ts'
 export * from './logger.ts'
 export * from './process.ts'
 export * from './queues.ts'
```

`apps/api/src/routes/health.ts` — изменения

```diff
--- a/apps/api/src/routes/health.ts
+++ b/apps/api/src/routes/health.ts
@@ -1,4 +1,5 @@
 import { sql } from 'drizzle-orm'
+import { readWorkerHeartbeat } from '@workspace/server'
 import { Hono } from 'hono'
 import type { AppEnv } from '../deps.ts'
 
@@ -9,7 +10,9 @@ export const healthRoutes = new Hono<AppEnv>().get('/healthz', async (c) => {
   try {
     await db.execute(sql`select 1`)
     await redis.ping()
-    return c.json({ ok: true, version })
+    // reported, not judged: the api stays healthy while the worker restarts
+    const worker = (await readWorkerHeartbeat(redis)) ? 'ok' : 'down'
+    return c.json({ ok: true, version, worker })
   } catch {
     return c.json({ ok: false, version }, 503)
   }
```

`apps/worker/package.json` — новый файл

```json
{
  "name": "worker",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "node --watch --env-file-if-exists=../../.env src/main.ts",
    "start": "node src/main.ts",
    "typecheck": "tsc -p tsconfig.json",
    "lint": "eslint ."
  },
  "dependencies": {
    "@workspace/db": "workspace:*",
    "@workspace/server": "workspace:*",
    "@workspace/shared": "workspace:*",
    "bullmq": "^6.3.11",
    "drizzle-orm": "^0.45.3",
    "ioredis": "^6.0.0",
    "pg": "^8.23.1",
    "zod": "^4.6.5"
  },
  "devDependencies": {
    "@types/node": "^26.6.4",
    "@types/pg": "^8.23.1",
    "typescript": "~6.0.3",
    "vitest": "^5.0.3"
  }
}
```

`apps/worker/src/deps.ts` — новый файл

```ts
import type { Db } from '@workspace/db'
import type { EventBus, Logger, Redis, SettingsService } from '@workspace/server'
import type { Cipher } from '@workspace/shared/crypto'
import type { Env } from '@workspace/shared/env'
import type pg from 'pg'

export interface WorkerDeps {
  env: Env
  db: Db
  pool: pg.Pool
  /** general-purpose connection (heartbeat, locks); never in subscriber mode */
  redis: Redis
  /** BullMQ connection (maxRetriesPerRequest: null) */
  queueRedis: Redis
  bus: EventBus
  settings: SettingsService
  cipher: Cipher
  logger: Logger
  /** BullMQ key prefix; tests use their own */
  queuePrefix?: string
}
```

`apps/worker/src/lock.ts` — новый файл

```ts
import type pg from 'pg'

/** Only one worker may hold Telegram sessions: two clients on one auth key end in AUTH_KEY_DUPLICATED. */
export const WORKER_LOCK_KEY = 'accs:worker'

export interface SingletonLock {
  release(): Promise<void>
}

export interface LockOptions {
  key?: string
  retryMs?: number
  /** called once if the lock is held elsewhere and we start waiting */
  onWaiting?: () => void
  /** the connection holding the lock broke: the lock is gone, the process must stop */
  onLost: (err: Error) => void
}

/**
 * Takes a session-level pg advisory lock on a dedicated pooled connection, polling until it is free
 * (a new worker started during a deploy waits for the old one to exit).
 */
export async function acquireSingletonLock(pool: pg.Pool, options: LockOptions): Promise<SingletonLock> {
  const key = options.key ?? WORKER_LOCK_KEY
  const client = await pool.connect()
  let waitingReported = false
  try {
    for (;;) {
      const { rows } = await client.query<{ ok: boolean }>('select pg_try_advisory_lock(hashtext($1)) as ok', [key])
      if (rows[0]?.ok) break
      if (!waitingReported) {
        waitingReported = true
        options.onWaiting?.()
      }
      await new Promise((resolve) => setTimeout(resolve, options.retryMs ?? 2_000))
    }
  } catch (err) {
    client.release(true)
    throw err
  }

  let released = false
  let lost = false
  // pg may emit several errors for one broken connection: report it once
  const onError = (err: Error) => {
    if (released || lost) return
    lost = true
    options.onLost(err)
  }
  client.on('error', onError)
  return {
    async release() {
      if (released) return
      released = true
      client.off('error', onError)
      // a query on a dead connection never settles: just destroy it, the lock died with it
      if (lost) {
        client.release(true)
        return
      }
      try {
        await client.query('select pg_advisory_unlock(hashtext($1))', [key])
        client.release()
      } catch {
        client.release(true)
      }
    },
  }
}
```

`apps/worker/src/main.ts` — новый файл

```ts
import { createDb } from '@workspace/db'
import { createEventBus, createLogger, createRedis, exitOnFatalErrors, SettingsService, startWorkerHeartbeat } from '@workspace/server'
import { createCipher } from '@workspace/shared/crypto'
import { loadEnv } from '@workspace/shared/env'
import type { WorkerDeps } from './deps.ts'
import { acquireSingletonLock } from './lock.ts'
import { createWorkerRuntime } from './runtime.ts'

const env = loadEnv()
const logger = createLogger({ level: env.LOG_LEVEL, pretty: env.NODE_ENV === 'development', name: 'worker' })
exitOnFatalErrors(logger)
const database = createDb(env.DATABASE_URL, { onError: (err) => logger.warn({ err }, 'postgres: idle client error') })

// one worker at a time: wait until a previous instance (e.g. during a deploy) lets go
const lock = await acquireSingletonLock(database.pool, {
  onWaiting: () => logger.info('worker: another instance holds the lock, waiting'),
  onLost: (err) => {
    logger.fatal({ err }, 'worker: lost the singleton lock connection, exiting')
    process.exit(1)
  },
})
logger.info('worker: lock acquired')

const redis = createRedis(env.REDIS_URL, 'worker', logger)
const subscriber = createRedis(env.REDIS_URL, 'worker-sub', logger)
const queueRedis = createRedis(env.REDIS_URL, 'worker-queues', logger, { forQueues: true })
const bus = await createEventBus({ publisher: redis, subscriber, logger })
const cipher = createCipher(env.APP_ENCRYPTION_KEY)
const settings = await SettingsService.create({ db: database.db, cipher, bus, logger })

const deps: WorkerDeps = { env, db: database.db, pool: database.pool, redis, queueRedis, bus, settings, cipher, logger }
const runtime = createWorkerRuntime(deps, { commands: {}, maintenance: {} })
await runtime.start()
const stopHeartbeat = startWorkerHeartbeat(redis, env.APP_VERSION)
logger.info('worker: started')

let stopping = false
async function shutdown(signal: string): Promise<void> {
  if (stopping) return
  stopping = true
  logger.info({ signal }, 'worker: shutting down')
  // compose gives 30 s (stop_grace_period); leave a margin
  setTimeout(() => process.exit(1), 25_000).unref()
  try {
    await runtime.stop()
    await stopHeartbeat()
    settings.close()
    await bus.close()
    await lock.release()
  } catch (err) {
    logger.error({ err }, 'worker: error during shutdown')
  } finally {
    await Promise.allSettled([redis.quit(), subscriber.quit(), queueRedis.quit(), database.close()])
    process.exit(0)
  }
}
process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))
```

`apps/worker/src/runtime.ts` — новый файл

```ts
import { QUEUE_PREFIX } from '@workspace/server'
import { COMMANDS_QUEUE, workerCommandSchema, type WorkerCommand, type WorkerCommandType } from '@workspace/shared/commands'
import { Queue, UnrecoverableError, Worker, type Job } from 'bullmq'
import type { WorkerDeps } from './deps.ts'
import { MAINTENANCE_QUEUE, MAINTENANCE_TASKS, SCHEDULE_SETTINGS, schedulePlan, type MaintenanceTask } from './schedule.ts'

export type CommandHandlers = {
  [K in WorkerCommandType]?: (command: Extract<WorkerCommand, { type: K }>) => Promise<unknown>
}
export type MaintenanceHandlers = { [K in MaintenanceTask]?: () => Promise<void> }

export interface WorkerRuntime {
  start(): Promise<void>
  stop(): Promise<void>
}

/**
 * Wires the worker's queues: commands from the api (answered through BullMQ results) and maintenance
 * tasks run by BullMQ job schedulers. Feature modules plug in through the handler maps.
 */
export function createWorkerRuntime(
  deps: WorkerDeps,
  handlers: { commands: CommandHandlers; maintenance: MaintenanceHandlers },
  options: { commandConcurrency?: number } = {},
): WorkerRuntime {
  const prefix = deps.queuePrefix ?? QUEUE_PREFIX
  const { logger } = deps
  let maintenanceQueue: Queue | undefined
  const workers: Worker[] = []
  const offs: (() => void)[] = []

  async function applySchedules(): Promise<void> {
    const plan = schedulePlan(deps.settings)
    for (const task of MAINTENANCE_TASKS) {
      await maintenanceQueue!.upsertJobScheduler(task, { every: plan[task] }, { name: task, opts: { removeOnComplete: true, removeOnFail: 50 } })
    }
  }

  async function processCommand(job: Job): Promise<unknown> {
    const parsed = workerCommandSchema.safeParse(job.data)
    if (!parsed.success) throw new UnrecoverableError(`invalid command: ${job.name}`)
    const command = parsed.data
    const handler = handlers.commands[command.type] as ((c: WorkerCommand) => Promise<unknown>) | undefined
    if (!handler) throw new UnrecoverableError(`no handler for ${command.type}`)
    return handler(command)
  }

  async function processMaintenance(job: Job): Promise<void> {
    const handler = handlers.maintenance[job.name as MaintenanceTask]
    if (handler) await handler()
  }

  return {
    async start() {
      maintenanceQueue = new Queue(MAINTENANCE_QUEUE, { connection: deps.queueRedis, prefix })
      await applySchedules()
      for (const key of SCHEDULE_SETTINGS) {
        offs.push(
          deps.settings.onChange(key, () => {
            applySchedules().catch((err: unknown) => logger.error({ err }, 'worker: re-planning maintenance failed'))
          }),
        )
      }
      const common = { prefix, autorun: true }
      workers.push(
        new Worker(MAINTENANCE_QUEUE, processMaintenance, { ...common, connection: deps.queueRedis.duplicate(), concurrency: 1 }),
        new Worker(COMMANDS_QUEUE, processCommand, { ...common, connection: deps.queueRedis.duplicate(), concurrency: options.commandConcurrency ?? 4 }),
      )
      for (const worker of workers) {
        worker.on('failed', (job, err) => logger.warn({ err, queue: worker.name, job: job?.name }, 'worker: job failed'))
        worker.on('error', (err) => logger.error({ err, queue: worker.name }, 'worker: queue error'))
      }
    },
    async stop() {
      for (const off of offs.splice(0)) off()
      // close() waits for running jobs to finish
      await Promise.allSettled(workers.splice(0).map((w) => w.close()))
      await maintenanceQueue?.close()
    },
  }
}
```

`apps/worker/src/schedule.ts` — новый файл

```ts
import { parseDuration } from '@workspace/shared/duration'
import type { SettingKey } from '@workspace/shared/settings'
import type { SettingsService } from '@workspace/server'

export const MAINTENANCE_QUEUE = 'maintenance'

export const MAINTENANCE_TASKS = ['proxies.checkDue', 'proxies.sync', 'accounts.refreshProfiles', 'housekeeping'] as const
export type MaintenanceTask = (typeof MAINTENANCE_TASKS)[number]

/** Settings whose change re-plans the schedule. */
export const SCHEDULE_SETTINGS: readonly SettingKey[] = ['proxyStore.syncInterval', 'worker.profileRefreshInterval']

/**
 * How often each maintenance task runs. Proxy checks tick every minute and pick the proxies that are due
 * (proxy.checkInterval, or sooner for failing ones); the rest follow their settings.
 */
export function schedulePlan(settings: Pick<SettingsService, 'get'>): Record<MaintenanceTask, number> {
  return {
    'proxies.checkDue': 60_000,
    'proxies.sync': parseDuration(settings.get('proxyStore.syncInterval')),
    'accounts.refreshProfiles': parseDuration(settings.get('worker.profileRefreshInterval')),
    housekeeping: 60 * 60_000,
  }
}
```

`apps/worker/tsconfig.json` — новый файл

```json
{
  "extends": "../../tsconfig.node.json",
  "include": ["src", "test"]
}
```

`Dockerfile` — изменения

```diff
--- a/Dockerfile
+++ b/Dockerfile
@@ -9,6 +9,7 @@ WORKDIR /app
 FROM base AS manifests
 COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
 COPY apps/api/package.json apps/api/
+COPY apps/worker/package.json apps/worker/
 COPY apps/web/package.json apps/web/
 COPY packages/db/package.json packages/db/
 COPY packages/server/package.json packages/server/
@@ -24,9 +25,9 @@ COPY packages/shared packages/shared
 COPY apps/web apps/web
 RUN pnpm --filter web build
 
-# ---- production deps of api and its workspace packages (symlinked, not injected) ----
+# ---- production deps of api, worker and their workspace packages (symlinked, not injected) ----
 FROM manifests AS api-deps
-RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile --prod --filter "api..."
+RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile --prod --filter "api..." --filter "worker..."
 
 # ---- runtime: Node runs the TypeScript sources directly (type stripping) ----
 FROM node:26-trixie-slim AS api
@@ -41,6 +42,7 @@ COPY --chown=node:node packages/db/src packages/db/src
 COPY --chown=node:node packages/db/drizzle packages/db/drizzle
 COPY --chown=node:node packages/server/src packages/server/src
 COPY --chown=node:node apps/api/src apps/api/src
+COPY --chown=node:node apps/worker/src apps/worker/src
 COPY --from=web-build --chown=node:node /app/apps/web/dist apps/web/dist
 USER node
 EXPOSE 3000
```

`compose.prod.yml` — изменения

```diff
--- a/compose.prod.yml
+++ b/compose.prod.yml
@@ -19,3 +19,7 @@ services:
     image: ${ACCS_IMAGE:?ACCS_IMAGE is set by deploy.sh}
     build: !reset null
     logging: *logging
+  accs-worker:
+    image: ${ACCS_IMAGE:?ACCS_IMAGE is set by deploy.sh}
+    build: !reset null
+    logging: *logging
```

`compose.yml` — изменения

```diff
--- a/compose.yml
+++ b/compose.yml
@@ -78,6 +78,31 @@ services:
       accs-redis:
         condition: service_healthy
 
+  # Telegram sessions, proxy checks, notifications. One instance only (pg advisory lock); stopped before a
+  # new one starts, so two clients never share an auth key. No ports.
+  accs-worker:
+    <<: *api-image
+    container_name: accs-worker
+    restart: unless-stopped
+    init: true
+    command: ["node", "apps/worker/src/main.ts"]
+    stop_grace_period: 30s
+    # the image healthcheck probes the api port; the worker reports through its Redis heartbeat instead
+    healthcheck:
+      disable: true
+    environment:
+      NODE_ENV: production
+      DATABASE_URL: *db-url
+      REDIS_URL: redis://accs-redis:6379
+      APP_ENCRYPTION_KEY: ${APP_ENCRYPTION_KEY:?set APP_ENCRYPTION_KEY in .env}
+      PUBLIC_ORIGIN: ${PUBLIC_ORIGIN:?set PUBLIC_ORIGIN in .env}
+      LOG_LEVEL: ${LOG_LEVEL:-info}
+    depends_on:
+      accs-migrate:
+        condition: service_completed_successfully
+      accs-redis:
+        condition: service_healthy
+
 volumes:
   accs-pgdata:
     name: accs-pgdata
```

`vitest.config.ts` — изменения

Добавить проект `worker` (как `api`: node-окружение, глобальный setup с Postgres/Redis).

```diff
--- a/vitest.config.ts
+++ b/vitest.config.ts
@@ -11,6 +11,7 @@ export default defineConfig({
       { test: { name: 'db', root: './packages/db', environment: 'node', ...integration } },
       { test: { name: 'server', root: './packages/server', environment: 'node', ...integration } },
       { test: { name: 'api', root: './apps/api', environment: 'node', ...integration } },
+      { test: { name: 'worker', root: './apps/worker', environment: 'node', ...integration } },
       // folder project: uses apps/web/vite.config.ts (jsdom, setup file)
       'apps/web',
     ],
```

- [ ] **Шаг 5: Проверки**

```bash
fnm exec --using=26 pnpm typecheck
fnm exec --using=26 pnpm lint
fnm exec --using=26 npx vitest run --project api --project worker
# всё зелёное
```

- [ ] **Шаг 6: Коммит**

```bash
git add -A
git commit -F - <<'MSG'
feat(worker): worker process — singleton pg lock, BullMQ command and maintenance queues, heartbeat; accs-worker in compose; healthz reports the worker
MSG
```

---

### Task 5: API прокси

Пул прокси в API. Пароль прокси шифруется `APP_ENCRYPTION_KEY` и наружу не отдаётся (`hasPassword`). Импорт — в два шага: `POST /proxies/import/preview` (разбор, ошибки по строкам, повторы в списке и уже в пуле) и `POST /proxies/import` (тело не пишется в аудит — в нём пароли). `POST /proxies/:id/check` и `POST /proxies/sync` ставят команды воркеру и отвечают 202. Привязанный к аккаунту прокси удалить нельзя (409 `proxy_in_use` — сначала сменить прокси у аккаунта), прокси из proxy-store — только отключить (им управляет синхронизация). Ошибки предметной области — `DomainError(status, code, message)`.

**Files:**
- Modify: `apps/api/src/app.ts`
- Modify: `apps/api/src/deps.ts`
- Create: `apps/api/src/lib/errors.ts`
- Modify: `apps/api/src/main.ts`
- Create: `apps/api/src/routes/proxies.ts`
- Create: `apps/api/src/services/proxies.ts`
- Test (modify): `apps/api/test/helpers.ts`
- Test: `apps/api/test/proxies.test.ts`

**Interfaces:**
- Consumes: `parseProxyList`, DTO из `@workspace/shared/proxies` (задача 2); `createCommandClient` (задача 3); `cipher` из `@workspace/shared/crypto`.
- Produces:
  - `apps/api/src/lib/errors.ts`: `class DomainError`
  - `apps/api/src/routes/proxies.ts`: `proxyRoutes`
  - `apps/api/src/services/proxies.ts`: `toProxyDto(row: ProxyRow, account: AccountRef): ProxyDto`; `listProxies(db: Db): Promise<ProxyDto[]>`; `getProxy(db: Db, id: string): Promise<ProxyDto>`; `createProxy(db: Db, cipher: Cipher, input: CreateProxyInput): Promise<ProxyDto>`; `previewProxyImport(db: Db, input: ImportProxiesInput): Promise<ImportProxiesPreview>`; `importProxies(db: Db, cipher: Cipher, input: ImportProxiesInput): Promise<ImportProxiesResult & { ids: string[] }>`; `updateProxy(db: Db, id: string, input: UpdateProxyInput): Promise<ProxyDto>`; `deleteProxy(db: Db, id: string): Promise<void>`

- [ ] **Шаг 1: Написать падающий тест**

`apps/api/test/helpers.ts` — изменения

```diff
--- a/apps/api/test/helpers.ts
+++ b/apps/api/test/helpers.ts
@@ -1,6 +1,7 @@
 import { randomBytes, randomUUID } from 'node:crypto'
 import { createTestDatabase, type TestDatabase } from '@workspace/db/testing'
-import { createEventBus, createLogger, createRedis, SettingsService, type EventBus, type Redis } from '@workspace/server'
+import { createEventBus, createLogger, createRedis, SettingsService, type CommandClient, type EventBus, type Redis } from '@workspace/server'
+import type { WorkerCommand } from '@workspace/shared/commands'
 import { createCipher } from '@workspace/shared/crypto'
 import { loadEnv, type Env } from '@workspace/shared/env'
 import { inject } from 'vitest'
@@ -15,9 +16,27 @@ export interface TestApp {
   deps: AppDeps
   t: TestDatabase
   bus: EventBus
+  commands: FakeCommands
   close(): Promise<void>
 }
 
+/** Records what the api asks the worker; `respond` answers `call()` like the worker would. */
+export class FakeCommands implements CommandClient {
+  sent: WorkerCommand[] = []
+  respond: (command: WorkerCommand) => unknown = () => null
+
+  async send(command: WorkerCommand): Promise<void> {
+    this.sent.push(command)
+  }
+
+  async call<T>(command: WorkerCommand): Promise<T> {
+    this.sent.push(command)
+    return (await this.respond(command)) as T
+  }
+
+  async close(): Promise<void> {}
+}
+
 export async function setupApp(envOverrides: Record<string, string> = {}): Promise<TestApp> {
   const t = await createTestDatabase(inject('pgAdminUrl'))
   const redisUrl = inject('redisUrl')
@@ -33,12 +52,15 @@ export async function setupApp(envOverrides: Record<string, string> = {}): Promi
     ...envOverrides,
   })
   const settings = await SettingsService.create({ db: t.db, cipher: createCipher(env.APP_ENCRYPTION_KEY), bus })
-  const deps: AppDeps = { env, db: t.db, redis, bus, settings, logger: createLogger({ level: 'silent' }) }
+  const cipher = createCipher(env.APP_ENCRYPTION_KEY)
+  const commands = new FakeCommands()
+  const deps: AppDeps = { env, db: t.db, redis, bus, settings, cipher, commands, logger: createLogger({ level: 'silent' }) }
   return {
     app: createApp(deps),
     deps,
     t,
     bus,
+    commands,
     async close() {
       settings.close()
       await bus.close()
```

`apps/api/test/proxies.test.ts` — новый файл

```ts
import { accounts, auditLog, proxies } from '@workspace/db'
import type { ProxyDto } from '@workspace/shared/proxies'
import { desc, eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { loginAs, send, setupApp, type TestApp } from './helpers.ts'

let ta: TestApp
let cookie: string
beforeAll(async () => {
  ta = await setupApp()
  cookie = (await loginAs(ta)).cookie
})
afterAll(async () => {
  await ta.close()
})

const lastAudit = async (action: string) =>
  (await ta.t.db.select().from(auditLog).where(eq(auditLog.action, action)).orderBy(desc(auditLog.id)).limit(1))[0]

describe('proxies api', () => {
  it('requires a session', async () => {
    expect((await send(ta.app, '/api/proxies')).status).toBe(401)
  })

  it('adds a manual proxy: password encrypted, never returned, check requested', async () => {
    ta.commands.sent = []
    const res = await send(ta.app, '/api/proxies', {
      cookie,
      body: { type: 'socks5', host: '194.53.188.22', port: 50101, username: 'kz1', password: 's3cret-pass', tag: 'kz' },
    })
    expect(res.status).toBe(201)
    const dto = (await res.json()) as ProxyDto
    expect(dto).toMatchObject({ source: 'manual', type: 'socks5', host: '194.53.188.22', username: 'kz1', hasPassword: true, status: 'unchecked', account: null })
    expect(JSON.stringify(dto)).not.toContain('s3cret-pass')
    const [row] = await ta.t.db.select().from(proxies).where(eq(proxies.id, dto.id))
    expect(row!.passwordEnc).toMatch(/^v1:/)
    expect(ta.deps.cipher.decrypt(row!.passwordEnc!)).toBe('s3cret-pass')
    expect(ta.commands.sent).toEqual([{ type: 'proxy.check', proxyId: dto.id }])
    expect(JSON.stringify((await lastAudit('proxy.create'))!.payload)).not.toContain('s3cret-pass')

    const again = await send(ta.app, '/api/proxies', { cookie, body: { type: 'socks5', host: '194.53.188.22', port: 50101, username: 'kz1', password: 'x' } })
    expect(again.status).toBe(409)
    expect(await again.json()).toMatchObject({ error: 'proxy_exists' })
  })

  it('previews a pasted list: new, invalid, repeated and already-known lines; no passwords echoed', async () => {
    const text = [
      'socks5://kz1:s3cret-pass@194.53.188.22:50101', // already in the pool
      '194.53.188.98:50100:kz2:pw-two',
      'garbage',
      '194.53.188.98:50100:kz2:pw-two',
    ].join('\n')
    const res = await send(ta.app, '/api/proxies/import/preview', { cookie, body: { text, defaultType: 'http' } })
    expect(res.status).toBe(200)
    const preview = await res.json()
    expect(preview).toEqual({
      proxies: [{ line: 2, type: 'http', host: '194.53.188.98', port: 50100, username: 'kz2' }],
      errors: [{ line: 3, text: 'garbage', reason: 'Ожидается host:port' }],
      duplicates: [
        { line: 1, text: 'socks5://kz1:s3cret-pass@194.53.188.22:50101', reason: 'exists' },
        { line: 4, text: '194.53.188.98:50100:kz2:pw-two', reason: 'repeated' },
      ],
    })
  })

  it('imports a list without writing the raw text into the audit log', async () => {
    const text = '194.53.188.98:50100:kz2:pw-two\n194.53.188.215:50100:kz3:pw-three\nsocks5://kz1:s3cret-pass@194.53.188.22:50101'
    const res = await send(ta.app, '/api/proxies/import', { cookie, body: { text, defaultType: 'http', tag: 'batch-1' } })
    expect(await res.json()).toEqual({ created: 2, skipped: 1 })
    const audit = await lastAudit('proxy.import')
    expect(audit!.payload).toEqual({ created: 2, skipped: 1, defaultType: 'http', tag: 'batch-1' })
    const list = ((await (await send(ta.app, '/api/proxies', { cookie })).json()) as { items: ProxyDto[] }).items
    expect(list.filter((p) => p.tag === 'batch-1')).toHaveLength(2)
  })

  it('shows the bound account and protects bound and synced proxies', async () => {
    const [bound] = await ta.t.db.insert(proxies).values({ source: 'manual', type: 'http', host: '10.1.1.1', port: 3128 }).returning()
    const [synced] = await ta.t.db.insert(proxies).values({ source: 'proxy_store', externalId: '5133763', type: 'http', host: '10.1.1.2', port: 3128 }).returning()
    const [loose] = await ta.t.db.insert(proxies).values({ source: 'manual', type: 'http', host: '10.1.1.3', port: 3128 }).returning()
    const device = { deviceModel: 'Desktop', systemVersion: 'Windows 11 x64', appVersion: '7.2.9 x64', langCode: 'ru' }
    const [account] = await ta.t.db
      .insert(accounts)
      .values({ tgUserId: 777, phone: '77001234567', label: 'main', source: 'tdata', clientProfile: 'desktop', device, connectionMode: 'proxy', proxyId: bound!.id })
      .returning()

    const list = ((await (await send(ta.app, '/api/proxies', { cookie })).json()) as { items: ProxyDto[] }).items
    expect(list.find((p) => p.id === bound!.id)!.account).toEqual({ id: account!.id, label: 'main', phone: '77001234567', username: null })

    const disableBound = await send(ta.app, `/api/proxies/${bound!.id}`, { cookie, method: 'PATCH', body: { disabled: true } })
    expect(disableBound.status).toBe(409)
    expect((await send(ta.app, `/api/proxies/${bound!.id}`, { cookie, method: 'DELETE' })).status).toBe(409)
    expect(await (await send(ta.app, `/api/proxies/${synced!.id}`, { cookie, method: 'DELETE' })).json()).toMatchObject({ error: 'managed_by_sync' })

    const disabled = await (await send(ta.app, `/api/proxies/${synced!.id}`, { cookie, method: 'PATCH', body: { disabled: true, tag: 'kz' } })).json()
    expect(disabled).toMatchObject({ tag: 'kz', disabledAt: expect.any(String) })
    const enabled = (await (await send(ta.app, `/api/proxies/${synced!.id}`, { cookie, method: 'PATCH', body: { disabled: false } })).json()) as ProxyDto
    expect(enabled.disabledAt).toBeNull()

    expect((await send(ta.app, `/api/proxies/${loose!.id}`, { cookie, method: 'DELETE' })).status).toBe(204)
    expect((await send(ta.app, `/api/proxies/${loose!.id}`, { cookie, method: 'DELETE' })).status).toBe(404)
  })

  it('asks the worker to check one proxy or to sync proxy-store', async () => {
    const [p] = await ta.t.db.insert(proxies).values({ source: 'manual', type: 'http', host: '10.2.2.2', port: 80 }).returning()
    ta.commands.sent = []
    expect((await send(ta.app, `/api/proxies/${p!.id}/check`, { cookie, method: 'POST' })).status).toBe(202)
    expect((await send(ta.app, '/api/proxies/sync', { cookie, method: 'POST' })).status).toBe(202)
    expect(ta.commands.sent).toEqual([{ type: 'proxy.check', proxyId: p!.id }, { type: 'proxy.sync' }])
  })
})
```

- [ ] **Шаг 2: Убедиться, что тест падает**

```bash
fnm exec --using=26 npx vitest run --project api apps/api/test/proxies.test.ts
# FAIL: Cannot find module '../src/services/proxies.ts' / 404 на /api/proxies
```

- [ ] **Шаг 3: Реализация**

`apps/api/src/app.ts` — изменения

```diff
--- a/apps/api/src/app.ts
+++ b/apps/api/src/app.ts
@@ -8,13 +8,16 @@ import type { AppDeps, AppEnv } from './deps.ts'
 import { resolveClientIp } from './lib/client-ip.ts'
 import { auditTrail } from './middleware/audit.ts'
 import { requireAuth, sessionLoader } from './middleware/auth.ts'
+import { DomainError } from './lib/errors.ts'
 import { originGuard } from './middleware/origin.ts'
 import { adminRoutes } from './routes/admins.ts'
 import { auditRoutes } from './routes/audit.ts'
 import { authRoutes } from './routes/auth.ts'
 import { eventRoutes } from './routes/events.ts'
 import { healthRoutes } from './routes/health.ts'
+import { proxyRoutes } from './routes/proxies.ts'
 import { settingsRoutes } from './routes/settings.ts'
+import { WorkerTimeoutError } from '@workspace/server'
 import { AdminError } from './services/admins.ts'
 
 /** Global cap on request bodies; plan-3 upload routes must be excluded and get their own route-level limit (import.maxZipSizeMb). */
@@ -58,6 +61,7 @@ export function createApp(deps: AppDeps): Hono<AppEnv> {
   api.use('*', requireAuth)
   api.route('/', adminRoutes)
   api.route('/', settingsRoutes)
+  api.route('/', proxyRoutes)
   api.route('/', auditRoutes)
   api.route('/', eventRoutes)
   api.all('*', (c) => c.json({ error: 'not_found' }, 404))
@@ -73,6 +77,8 @@ export function createApp(deps: AppDeps): Hono<AppEnv> {
       const [status, message] = ADMIN_ERRORS[err.code]
       return c.json({ error: err.code, message }, status)
     }
+    if (err instanceof DomainError) return c.json({ error: err.code, message: err.message }, err.status)
+    if (err instanceof WorkerTimeoutError) return c.json({ error: 'worker_timeout', message: 'Воркер не ответил вовремя — попробуйте ещё раз' }, 504)
     if (err instanceof HTTPException) return err.getResponse()
     deps.logger.error({ err, path: c.req.path }, 'unhandled error')
     return c.json({ error: 'internal', message: 'Внутренняя ошибка' }, 500)
```

`apps/api/src/deps.ts` — изменения

```diff
--- a/apps/api/src/deps.ts
+++ b/apps/api/src/deps.ts
@@ -1,5 +1,6 @@
 import type { Db } from '@workspace/db'
-import type { EventBus, Logger, Redis, SettingsService } from '@workspace/server'
+import type { CommandClient, EventBus, Logger, Redis, SettingsService } from '@workspace/server'
+import type { Cipher } from '@workspace/shared/crypto'
 import type { Env } from '@workspace/shared/env'
 
 export interface AppDeps {
@@ -9,6 +10,10 @@ export interface AppDeps {
   redis: Redis
   bus: EventBus
   settings: SettingsService
+  /** encrypts proxy passwords and imported sessions with APP_ENCRYPTION_KEY */
+  cipher: Cipher
+  /** asks the worker to act (check a proxy, start an account, list sessions) */
+  commands: CommandClient
   logger: Logger
   /** absolute path to the built SPA; static serving is skipped when undefined */
   webDistDir?: string
```

`apps/api/src/lib/errors.ts` — новый файл

```ts
/** An expected failure the client can act on: becomes `{ error: code, message }` with `status`. */
export class DomainError extends Error {
  readonly status: 400 | 404 | 409 | 422 | 503 | 504
  readonly code: string

  constructor(status: DomainError['status'], code: string, message: string) {
    super(message)
    this.name = 'DomainError'
    this.status = status
    this.code = code
  }
}
```

`apps/api/src/main.ts` — изменения

```diff
--- a/apps/api/src/main.ts
+++ b/apps/api/src/main.ts
@@ -1,7 +1,7 @@
 import { fileURLToPath } from 'node:url'
 import { serve } from '@hono/node-server'
 import { createDb } from '@workspace/db'
-import { createEventBus, createLogger, createRedis, exitOnFatalErrors, SettingsService } from '@workspace/server'
+import { createCommandClient, createEventBus, createLogger, createRedis, exitOnFatalErrors, SettingsService } from '@workspace/server'
 import { createCipher } from '@workspace/shared/crypto'
 import { loadEnv } from '@workspace/shared/env'
 import { createApp } from './app.ts'
@@ -14,7 +14,10 @@ const database = createDb(env.DATABASE_URL, { onError: (err) => logger.warn({ er
 const redis = createRedis(env.REDIS_URL, 'api', logger)
 const subscriber = createRedis(env.REDIS_URL, 'api-sub', logger)
 const bus = await createEventBus({ publisher: redis, subscriber, logger })
-const settings = await SettingsService.create({ db: database.db, cipher: createCipher(env.APP_ENCRYPTION_KEY), bus, logger })
+const cipher = createCipher(env.APP_ENCRYPTION_KEY)
+const settings = await SettingsService.create({ db: database.db, cipher, bus, logger })
+const queueRedis = createRedis(env.REDIS_URL, 'api-queues', logger, { forQueues: true })
+const commands = createCommandClient(queueRedis)
 
 const app = createApp({
   env,
@@ -22,6 +25,8 @@ const app = createApp({
   redis,
   bus,
   settings,
+  cipher,
+  commands,
   logger,
   webDistDir: fileURLToPath(new URL('../../web/dist', import.meta.url)),
 })
@@ -45,11 +50,12 @@ async function shutdown(signal: string): Promise<void> {
       }, 3_000).unref()
     })
     settings.close()
+    await commands.close()
     await bus.close()
   } catch (err) {
     logger.error({ err }, 'api: error during shutdown')
   } finally {
-    await Promise.allSettled([redis.quit(), subscriber.quit(), database.close()])
+    await Promise.allSettled([redis.quit(), subscriber.quit(), queueRedis.quit(), database.close()])
     process.exit(0)
   }
 }
```

`apps/api/src/routes/proxies.ts` — новый файл

```ts
import { zValidator } from '@hono/zod-validator'
import { createProxyInput, importProxiesInput, updateProxyInput } from '@workspace/shared/proxies'
import { Hono } from 'hono'
import { z } from 'zod'
import type { AppEnv } from '../deps.ts'
import { audited } from '../middleware/audit.ts'
import { createProxy, deleteProxy, importProxies, listProxies, previewProxyImport, updateProxy } from '../services/proxies.ts'
import { validationHook } from './validation.ts'

const idParam = z.object({ id: z.uuid() })

export const proxyRoutes = new Hono<AppEnv>()
  .get('/proxies', async (c) => c.json({ items: await listProxies(c.get('deps').db) }))
  .post('/proxies', audited('proxy.create'), zValidator('json', createProxyInput, validationHook), async (c) => {
    const { db, cipher, commands, bus } = c.get('deps')
    const proxy = await createProxy(db, cipher, c.req.valid('json'))
    c.set('audit', { ...c.get('audit'), targetType: 'proxy', targetId: proxy.id })
    await commands.send({ type: 'proxy.check', proxyId: proxy.id })
    await bus.publish({ type: 'proxies.changed', ids: [proxy.id] })
    return c.json(proxy, 201)
  })
  // pasted lists carry passwords inline: the raw body never reaches the audit log
  .post('/proxies/import/preview', zValidator('json', importProxiesInput, validationHook), async (c) =>
    c.json(await previewProxyImport(c.get('deps').db, c.req.valid('json'))),
  )
  .post('/proxies/import', audited('proxy.import', { payload: null }), zValidator('json', importProxiesInput, validationHook), async (c) => {
    const { db, cipher, bus } = c.get('deps')
    const input = c.req.valid('json')
    const { ids, ...result } = await importProxies(db, cipher, input)
    c.set('audit', { ...c.get('audit'), payload: { ...result, defaultType: input.defaultType, tag: input.tag ?? null } })
    // new proxies are 'unchecked': the worker's next checkDue tick (≤ 1 min) checks them
    if (ids.length > 0) await bus.publish({ type: 'proxies.changed', ids })
    return c.json(result)
  })
  .patch('/proxies/:id', audited('proxy.update', { target: ['proxy', 'id'] }), zValidator('param', idParam, validationHook), zValidator('json', updateProxyInput, validationHook), async (c) => {
    const { db, bus } = c.get('deps')
    const proxy = await updateProxy(db, c.req.valid('param').id, c.req.valid('json'))
    await bus.publish({ type: 'proxies.changed', ids: [proxy.id] })
    return c.json(proxy)
  })
  .delete('/proxies/:id', audited('proxy.delete', { target: ['proxy', 'id'] }), zValidator('param', idParam, validationHook), async (c) => {
    const { db, bus } = c.get('deps')
    const { id } = c.req.valid('param')
    await deleteProxy(db, id)
    await bus.publish({ type: 'proxies.changed', ids: [id] })
    return c.body(null, 204)
  })
  .post('/proxies/:id/check', audited('proxy.check', { target: ['proxy', 'id'] }), zValidator('param', idParam, validationHook), async (c) => {
    await c.get('deps').commands.send({ type: 'proxy.check', proxyId: c.req.valid('param').id })
    return c.body(null, 202)
  })
  .post('/proxies/sync', audited('proxy.sync'), async (c) => {
    await c.get('deps').commands.send({ type: 'proxy.sync' })
    return c.body(null, 202)
  })
```

`apps/api/src/services/proxies.ts` — новый файл

```ts
import { accounts, proxies, type Db } from '@workspace/db'
import type { Cipher } from '@workspace/shared/crypto'
import {
  parseProxyList,
  proxyEndpointKey,
  type CreateProxyInput,
  type ImportProxiesInput,
  type ImportProxiesPreview,
  type ImportProxiesResult,
  type ProxyDto,
  type UpdateProxyInput,
} from '@workspace/shared/proxies'
import { eq, getTableColumns } from 'drizzle-orm'
import { DomainError } from '../lib/errors.ts'

type ProxyRow = typeof proxies.$inferSelect
type AccountRef = { id: string; label: string | null; phone: string | null; username: string | null } | null

const iso = (d: Date | null) => (d ? d.toISOString() : null)

export function toProxyDto(row: ProxyRow, account: AccountRef): ProxyDto {
  return {
    id: row.id,
    source: row.source,
    externalId: row.externalId,
    type: row.type,
    host: row.host,
    port: row.port,
    username: row.username,
    hasPassword: row.passwordEnc !== null,
    tag: row.tag,
    status: row.status,
    lastCheckAt: iso(row.lastCheckAt),
    lastOkAt: iso(row.lastOkAt),
    latencyMs: row.latencyMs,
    tgCountry: row.tgCountry,
    lastError: row.lastError,
    failStreak: row.failStreak,
    expiresAt: iso(row.expiresAt),
    disabledAt: iso(row.disabledAt),
    createdAt: row.createdAt.toISOString(),
    account,
  }
}

function selectWithAccount(db: Db) {
  return db
    .select({
      proxy: getTableColumns(proxies),
      account: { id: accounts.id, label: accounts.label, phone: accounts.phone, username: accounts.username },
    })
    .from(proxies)
    .leftJoin(accounts, eq(accounts.proxyId, proxies.id))
}

export async function listProxies(db: Db): Promise<ProxyDto[]> {
  const rows = await selectWithAccount(db).orderBy(proxies.createdAt)
  return rows.map((r) => toProxyDto(r.proxy, r.account?.id ? r.account : null))
}

export async function getProxy(db: Db, id: string): Promise<ProxyDto> {
  const [row] = await selectWithAccount(db).where(eq(proxies.id, id))
  if (!row) throw new DomainError(404, 'not_found', 'Прокси не найден')
  return toProxyDto(row.proxy, row.account?.id ? row.account : null)
}

const isUniqueViolation = (err: unknown) => (err as { cause?: { code?: string }; code?: string })?.cause?.code === '23505' || (err as { code?: string })?.code === '23505'

export async function createProxy(db: Db, cipher: Cipher, input: CreateProxyInput): Promise<ProxyDto> {
  try {
    const [row] = await db
      .insert(proxies)
      .values({
        source: 'manual',
        type: input.type,
        host: input.host,
        port: input.port,
        username: input.username || null,
        passwordEnc: input.password ? cipher.encrypt(input.password) : null,
        tag: input.tag ?? null,
      })
      .returning()
    return toProxyDto(row!, null)
  } catch (err) {
    if (isUniqueViolation(err)) throw new DomainError(409, 'proxy_exists', 'Такой прокси уже есть в пуле')
    throw err
  }
}

async function existingEndpointKeys(db: Db): Promise<Set<string>> {
  const rows = await db.select({ type: proxies.type, host: proxies.host, port: proxies.port, username: proxies.username }).from(proxies)
  return new Set(rows.map(proxyEndpointKey))
}

export async function previewProxyImport(db: Db, input: ImportProxiesInput): Promise<ImportProxiesPreview> {
  const parsed = parseProxyList(input.text, input.defaultType)
  const existing = await existingEndpointKeys(db)
  const preview: ImportProxiesPreview = { proxies: [], errors: parsed.errors, duplicates: parsed.repeated.map((r) => ({ ...r, reason: 'repeated' as const })) }
  const lines = input.text.split(/\r?\n/)
  for (const p of parsed.proxies) {
    if (existing.has(proxyEndpointKey(p))) {
      preview.duplicates.push({ line: p.line, text: lines[p.line - 1]!.trim(), reason: 'exists' })
    } else {
      preview.proxies.push({ line: p.line, type: p.type, host: p.host, port: p.port, username: p.username ?? null })
    }
  }
  preview.duplicates.sort((a, b) => a.line - b.line)
  return preview
}

export async function importProxies(db: Db, cipher: Cipher, input: ImportProxiesInput): Promise<ImportProxiesResult & { ids: string[] }> {
  const parsed = parseProxyList(input.text, input.defaultType)
  if (parsed.proxies.length === 0) return { created: 0, skipped: parsed.repeated.length, ids: [] }
  const rows = await db
    .insert(proxies)
    .values(
      parsed.proxies.map((p) => ({
        source: 'manual' as const,
        type: p.type,
        host: p.host,
        port: p.port,
        username: p.username ?? null,
        passwordEnc: p.password ? cipher.encrypt(p.password) : null,
        tag: input.tag ?? null,
      })),
    )
    .onConflictDoNothing()
    .returning({ id: proxies.id })
  return { created: rows.length, skipped: parsed.proxies.length - rows.length + parsed.repeated.length, ids: rows.map((r) => r.id) }
}

export async function updateProxy(db: Db, id: string, input: UpdateProxyInput): Promise<ProxyDto> {
  const current = await getProxy(db, id)
  const set: Partial<typeof proxies.$inferInsert> = {}
  if (input.tag !== undefined) set.tag = input.tag
  if (input.disabled !== undefined && input.disabled !== (current.disabledAt !== null)) {
    // a bound account would silently lose its proxy: change the account's proxy first
    if (input.disabled && current.account) throw new DomainError(409, 'proxy_in_use', 'Прокси привязан к аккаунту — сначала смените прокси у аккаунта')
    set.disabledAt = input.disabled ? new Date() : null
  }
  if (Object.keys(set).length > 0) await db.update(proxies).set(set).where(eq(proxies.id, id))
  return getProxy(db, id)
}

export async function deleteProxy(db: Db, id: string): Promise<void> {
  const proxy = await getProxy(db, id)
  if (proxy.account) throw new DomainError(409, 'proxy_in_use', 'Прокси привязан к аккаунту — сначала смените прокси у аккаунта')
  if (proxy.source === 'proxy_store') {
    throw new DomainError(409, 'managed_by_sync', 'Прокси из proxy-store управляется синхронизацией — его можно только отключить')
  }
  await db.delete(proxies).where(eq(proxies.id, id))
}
```

- [ ] **Шаг 4: Проверки**

```bash
fnm exec --using=26 pnpm typecheck
fnm exec --using=26 pnpm lint
fnm exec --using=26 npx vitest run --project api
# всё зелёное
```

- [ ] **Шаг 5: Коммит**

```bash
git add -A
git commit -F - <<'MSG'
feat(api): proxies — list with bound account, add, import list (preview + commit), update, delete, check and sync commands
MSG
```

---

### Task 6: Проверка здоровья прокси

Проверка в два уровня. Каждые `proxy.checkInterval` — дешёвая: транспортом mtcute (`HttpProxyTcpTransport` / `SocksProxyTcpTransport`) открыть туннель через прокси до DC2 `149.154.167.50:443`, задержка — время соединения. Не чаще раза в сутки — MTProto: временный клиент вызывает `help.getNearestDc`, `country` → `tg_country` (только для показа). Первая неудача → `failing` и перепроверка через 60 с, `proxy.failThreshold` подряд → `dead`, успех → `ok`; хуки `onDown`/`onUp` для аккаунтов (задача 11). Тексты ошибок очищаются от логина и пароля. Миграция `0002` добавляет `proxies.tg_checked_at`.

С mtcute в воркер приходит опциональный peer `better-sqlite3`, из-за которого pnpm ставит вторую копию `drizzle-orm` с несовместимыми типами: воркер больше не зависит от `drizzle-orm` напрямую, операторы (`eq`, `and`, `inArray`, `sql`, …) реэкспортирует `@workspace/db`. Сборка `better-sqlite3` запрещена в `allowBuilds`.

**Files:**
- Create: `packages/db/drizzle/0002_proxy_country_check.sql`
- Modify: `packages/db/src/index.ts`
- Modify: `packages/db/src/schema.ts`
- Modify: `apps/worker/package.json`
- Modify: `apps/worker/src/main.ts`
- Create: `apps/worker/src/proxies/checker.ts`
- Create: `apps/worker/src/proxies/health.ts`
- Test: `apps/worker/test/proxy-health.test.ts`
- Modify: `pnpm-workspace.yaml`
- Generated: `packages/db/drizzle/meta/0002_snapshot.json`, `packages/db/drizzle/meta/_journal.json`, `pnpm-lock.yaml` — не писать руками (команды ниже)

**Interfaces:**
- Consumes: `proxies` (задача 1); runtime и `MAINTENANCE_TASKS` (задача 4); `PROXY_STATUSES` (задача 2).
- Produces:
  - `apps/worker/src/proxies/checker.ts`: `interface ProxyEndpoint`; `interface ProxyChecker`; `proxyTransport(proxy: ProxyEndpoint): TelegramTransport`; `createMtcuteProxyChecker(app: () => { apiId: number; apiHash: string }, timeoutMs = TIMEOUT_MS): ProxyChecker`
  - `apps/worker/src/proxies/health.ts`: `FAILING_RECHECK_MS`; `COUNTRY_RECHECK_MS`; `isDue(row: Pick<ProxyRow, 'status' | 'lastCheckAt'>, now: Date, intervalMs: number): boolean`; `needsCountry(row: Pick<ProxyRow, 'tgCountry' | 'tgCheckedAt'>, now: Date): boolean`; `sanitizeProxyError(err: unknown, proxy: Pick<ProxyEndpoint, 'username' | 'password'>): string`; `interface ProxyHealthHooks`; `interface ProxyHealth`; `createProxyHealth(deps: WorkerDeps, checker: ProxyChecker, hooks: ProxyHealthHooks = {}): ProxyHealth`

- [ ] **Шаг 1: Зависимости**

```bash
fnm exec --using=26 pnpm --filter worker add '@mtcute/core@^0.32' '@mtcute/node@^0.32'
fnm exec --using=26 pnpm --filter worker remove drizzle-orm
# pnpm-workspace.yaml: better-sqlite3: false в allowBuilds — дифф ниже
```

- [ ] **Шаг 2: Написать падающий тест**

`apps/worker/test/proxy-health.test.ts` — новый файл

```ts
import { eq, proxies } from '@workspace/db'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProxyChecker } from '../src/proxies/checker.ts'
import { createProxyHealth, isDue, needsCountry, sanitizeProxyError } from '../src/proxies/health.ts'
import { setupWorker, type TestWorker } from './helpers.ts'

let w: TestWorker
beforeAll(async () => {
  w = await setupWorker()
})
afterAll(async () => {
  await w.close()
})
beforeEach(async () => {
  await w.t.db.delete(proxies)
})

const minutes = (n: number) => n * 60_000
const at = (base: Date, ms: number) => new Date(base.getTime() + ms)

describe('scheduling rules', () => {
  const now = new Date('2026-10-03T12:00:00Z')
  it('checks new proxies at once, failing ones every minute, others at the interval', () => {
    expect(isDue({ status: 'unchecked', lastCheckAt: null }, now, minutes(5))).toBe(true)
    expect(isDue({ status: 'ok', lastCheckAt: at(now, -minutes(4)) }, now, minutes(5))).toBe(false)
    expect(isDue({ status: 'ok', lastCheckAt: at(now, -minutes(5)) }, now, minutes(5))).toBe(true)
    expect(isDue({ status: 'failing', lastCheckAt: at(now, -minutes(1)) }, now, minutes(5))).toBe(true)
    expect(isDue({ status: 'dead', lastCheckAt: at(now, -minutes(1)) }, now, minutes(5))).toBe(false)
  })
  it('asks Telegram for the country at most once a day', () => {
    expect(needsCountry({ tgCountry: null, tgCheckedAt: null }, now)).toBe(true)
    expect(needsCountry({ tgCountry: 'KZ', tgCheckedAt: at(now, -minutes(60)) }, now)).toBe(false)
    expect(needsCountry({ tgCountry: 'KZ', tgCheckedAt: at(now, -minutes(24 * 60)) }, now)).toBe(true)
  })
  it('never shows proxy credentials in errors', () => {
    expect(sanitizeProxyError(new Error('auth failed for kz1:pw-1 at 1.1.1.1'), { username: 'kz1', password: 'pw-1' })).toBe('auth failed for ***:*** at 1.1.1.1')
  })
})

function fakeChecker(behaviour: { fail?: boolean; country?: string } = {}) {
  const state = { fail: behaviour.fail ?? false }
  const checker: ProxyChecker & { state: typeof state } = {
    state,
    tunnel: vi.fn(async () => {
      if (state.fail) throw new Error('connect ECONNREFUSED')
      return 42
    }),
    country: vi.fn(async () => behaviour.country ?? 'KZ'),
  }
  return checker
}

// a counter, not Math.random: the tests of this file share one database and endpoints are unique
let nextHost = 0
const insertProxy = async (values: Partial<typeof proxies.$inferInsert> = {}) =>
  (await w.t.db.insert(proxies).values({ source: 'manual', type: 'socks5', host: `10.0.0.${++nextHost}`, port: 1080, ...values }).returning())[0]!

const read = async (id: string) => (await w.t.db.select().from(proxies).where(eq(proxies.id, id)))[0]!

describe('proxy health', () => {
  it('marks a working proxy ok with latency and the country Telegram sees, once', async () => {
    const checker = fakeChecker({ country: 'JP' })
    const health = createProxyHealth(w.deps, checker)
    const p = await insertProxy({ passwordEnc: w.deps.cipher.encrypt('pw'), username: 'u' })
    expect(await health.checkDue()).toBe(1)
    expect(await read(p.id)).toMatchObject({ status: 'ok', latencyMs: 42, tgCountry: 'JP', failStreak: 0, lastError: null })
    expect(checker.tunnel).toHaveBeenCalledWith(expect.objectContaining({ username: 'u', password: 'pw' }))
    // forced re-check within a day: tunnel again, no second MTProto exchange
    await health.checkById(p.id)
    expect(checker.tunnel).toHaveBeenCalledTimes(2)
    expect(checker.country).toHaveBeenCalledTimes(1)
  })

  it('counts failures: failing, then dead at the threshold; recovers to ok', async () => {
    await w.deps.settings.update({ 'proxy.failThreshold': 2 }, { adminId: null })
    const checker = fakeChecker({ fail: true })
    const onDown = vi.fn()
    const onUp = vi.fn()
    const health = createProxyHealth(w.deps, checker, { onDown, onUp })
    const p = await insertProxy({ status: 'ok' })

    expect(await health.checkById(p.id)).toBe('failing')
    expect(onDown).not.toHaveBeenCalled()
    expect(await health.checkById(p.id)).toBe('dead')
    expect(await read(p.id)).toMatchObject({ status: 'dead', failStreak: 2, lastError: 'connect ECONNREFUSED' })
    expect(onDown).toHaveBeenCalledExactlyOnceWith(p.id)
    expect(await health.checkById(p.id)).toBe('dead')
    expect(onDown).toHaveBeenCalledOnce()

    checker.state.fail = false
    expect(await health.checkById(p.id)).toBe('ok')
    expect(onUp).toHaveBeenCalledExactlyOnceWith(p.id)
    expect(await read(p.id)).toMatchObject({ failStreak: 0, lastError: null })
    await w.deps.settings.update({ 'proxy.failThreshold': null }, { adminId: null })
  })

  it('skips disabled and not-yet-issued proxies and expires overdue ones', async () => {
    const checker = fakeChecker()
    const onDown = vi.fn()
    const health = createProxyHealth(w.deps, checker, { onDown })
    const now = new Date()
    await insertProxy({ disabledAt: now })
    await insertProxy({ status: 'provisioning' })
    const overdue = await insertProxy({ status: 'ok', source: 'proxy_store', externalId: '1', expiresAt: at(now, -1000), lastCheckAt: now })
    const fresh = await insertProxy({ status: 'ok', lastCheckAt: now })
    const received = vi.fn()
    const off = w.deps.bus.subscribe(received)
    try {
      expect(await health.checkDue(now)).toBe(0)
      expect(checker.tunnel).not.toHaveBeenCalled()
      expect((await read(overdue.id)).status).toBe('expired')
      expect((await read(fresh.id)).status).toBe('ok')
      expect(onDown).toHaveBeenCalledExactlyOnceWith(overdue.id)
      await vi.waitFor(() => expect(received).toHaveBeenCalledWith({ type: 'proxies.changed', ids: [overdue.id] }))
      expect(await health.checkById(overdue.id)).toBeNull()
    } finally {
      off()
    }
  })
})
```

- [ ] **Шаг 3: Убедиться, что тест падает**

```bash
fnm exec --using=26 npx vitest run --project worker apps/worker/test/proxy-health.test.ts
# FAIL: Cannot find module '../src/proxies/health.ts'
```

- [ ] **Шаг 4: Реализация**

`packages/db/src/index.ts` — изменения

```diff
--- a/packages/db/src/index.ts
+++ b/packages/db/src/index.ts
@@ -14,3 +14,7 @@ export {
   settings,
   type AccountDevice,
 } from './schema.ts'
+
+// one drizzle-orm instance for every workspace package: apps import the operators from here, not from drizzle-orm
+// (a second copy — e.g. a peer variant pulled by @mtcute/node's optional sqlite — makes their SQL types incompatible)
+export { and, asc, count, desc, eq, getTableColumns, gt, gte, inArray, isNotNull, isNull, lt, lte, ne, not, notInArray, or, sql } from 'drizzle-orm'
```

`packages/db/src/schema.ts` — изменения

```diff
--- a/packages/db/src/schema.ts
+++ b/packages/db/src/schema.ts
@@ -105,6 +105,8 @@ export const proxies = pgTable(
     latencyMs: integer('latency_ms'),
     /** country of the exit IP as Telegram sees it (help.getNearestDc); shown only */
     tgCountry: text('tg_country'),
+    /** when tgCountry was last asked from Telegram (a full MTProto exchange — done rarely) */
+    tgCheckedAt: ts('tg_checked_at'),
     lastError: text('last_error'),
     failStreak: integer('fail_streak').notNull().default(0),
     expiresAt: ts('expires_at'),
```

`apps/worker/package.json` — изменения

```diff
--- a/apps/worker/package.json
+++ b/apps/worker/package.json
@@ -10,11 +10,12 @@
     "lint": "eslint ."
   },
   "dependencies": {
+    "@mtcute/core": "^0.32.3",
+    "@mtcute/node": "^0.32.3",
     "@workspace/db": "workspace:*",
     "@workspace/server": "workspace:*",
     "@workspace/shared": "workspace:*",
     "bullmq": "^6.3.11",
-    "drizzle-orm": "^0.45.3",
     "ioredis": "^6.0.0",
     "pg": "^8.23.1",
     "zod": "^4.6.5"
```

`apps/worker/src/main.ts` — изменения

```diff
--- a/apps/worker/src/main.ts
+++ b/apps/worker/src/main.ts
@@ -4,6 +4,8 @@ import { createCipher } from '@workspace/shared/crypto'
 import { loadEnv } from '@workspace/shared/env'
 import type { WorkerDeps } from './deps.ts'
 import { acquireSingletonLock } from './lock.ts'
+import { createMtcuteProxyChecker } from './proxies/checker.ts'
+import { createProxyHealth } from './proxies/health.ts'
 import { createWorkerRuntime } from './runtime.ts'
 
 const env = loadEnv()
@@ -29,7 +31,19 @@ const cipher = createCipher(env.APP_ENCRYPTION_KEY)
 const settings = await SettingsService.create({ db: database.db, cipher, bus, logger })
 
 const deps: WorkerDeps = { env, db: database.db, pool: database.pool, redis, queueRedis, bus, settings, cipher, logger }
-const runtime = createWorkerRuntime(deps, { commands: {}, maintenance: {} })
+const proxyChecker = createMtcuteProxyChecker(() => ({ apiId: settings.get('telegram.desktop.apiId'), apiHash: settings.get('telegram.desktop.apiHash') }))
+const proxyHealth = createProxyHealth(deps, proxyChecker)
+
+const runtime = createWorkerRuntime(deps, {
+  commands: {
+    'proxy.check': async ({ proxyId }) => proxyHealth.checkById(proxyId),
+  },
+  maintenance: {
+    'proxies.checkDue': async () => {
+      await proxyHealth.checkDue()
+    },
+  },
+})
 await runtime.start()
 const stopHeartbeat = startWorkerHeartbeat(redis, env.APP_VERSION)
 logger.info('worker: started')
```

`apps/worker/src/proxies/checker.ts` — новый файл

```ts
import { HttpProxyTcpTransport, MemoryStorage, SocksProxyTcpTransport, TelegramClient, type TelegramTransport } from '@mtcute/node'

export interface ProxyEndpoint {
  type: 'socks5' | 'http'
  host: string
  port: number
  username: string | null
  password: string | null
}

export interface ProxyChecker {
  /** opens a TCP tunnel through the proxy to Telegram DC 2; resolves with how long it took, ms */
  tunnel(proxy: ProxyEndpoint): Promise<number>
  /** a real MTProto exchange without an account: the exit country as Telegram sees it (help.getNearestDc) */
  country(proxy: ProxyEndpoint): Promise<string>
}

/** Telegram's production DC 2 — any DC proves the proxy reaches Telegram. */
const TELEGRAM_DC = { id: 2, ipAddress: '149.154.167.50', port: 443 }
const TIMEOUT_MS = 20_000

export function proxyTransport(proxy: ProxyEndpoint): TelegramTransport {
  const settings = {
    host: proxy.host,
    port: proxy.port,
    ...(proxy.username ? { user: proxy.username } : {}),
    ...(proxy.password ? { password: proxy.password } : {}),
  }
  return proxy.type === 'socks5' ? new SocksProxyTcpTransport({ ...settings, version: 5 }) : new HttpProxyTcpTransport(settings)
}

async function withTimeout<T>(work: (signal: AbortSignal) => Promise<T>, ms: number): Promise<T> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error(`timeout after ${ms} ms`)), ms)
  try {
    return await Promise.race([
      work(controller.signal),
      new Promise<never>((_, reject) => controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true })),
    ])
  } finally {
    clearTimeout(timer)
  }
}

/** `app` supplies the api id/hash used for the occasional MTProto check (Telegram Desktop's by default). */
export function createMtcuteProxyChecker(app: () => { apiId: number; apiHash: string }, timeoutMs = TIMEOUT_MS): ProxyChecker {
  return {
    async tunnel(proxy) {
      return withTimeout(async (signal) => {
        const started = performance.now()
        const connection = await proxyTransport(proxy).connect(TELEGRAM_DC, signal)
        const elapsed = Math.round(performance.now() - started)
        connection.close()
        return elapsed
      }, timeoutMs)
    },
    async country(proxy) {
      const { apiId, apiHash } = app()
      const client = new TelegramClient({ apiId, apiHash, storage: new MemoryStorage(), transport: proxyTransport(proxy), logLevel: 0 })
      try {
        return await withTimeout(async () => {
          await client.connect()
          const dc = await client.call({ _: 'help.getNearestDc' })
          return dc.country
        }, timeoutMs)
      } finally {
        await client.destroy().catch(() => {})
      }
    },
  }
}
```

`apps/worker/src/proxies/health.ts` — новый файл

```ts
import { and, eq, isNull, lte, ne, notInArray, proxies } from '@workspace/db'
import { parseDuration } from '@workspace/shared/duration'
import type { ProxyStatus } from '@workspace/shared/proxies'
import type { WorkerDeps } from '../deps.ts'
import type { ProxyChecker, ProxyEndpoint } from './checker.ts'

type ProxyRow = typeof proxies.$inferSelect

/** Failing proxies are re-checked this often, ahead of their normal interval. */
export const FAILING_RECHECK_MS = 60_000
/** The country check costs a real MTProto exchange: at most once a day per proxy. */
export const COUNTRY_RECHECK_MS = 24 * 3_600_000
const CONCURRENCY = 5

export function isDue(row: Pick<ProxyRow, 'status' | 'lastCheckAt'>, now: Date, intervalMs: number): boolean {
  if (!row.lastCheckAt) return true
  const age = now.getTime() - row.lastCheckAt.getTime()
  return age >= (row.status === 'failing' ? FAILING_RECHECK_MS : intervalMs)
}

export function needsCountry(row: Pick<ProxyRow, 'tgCountry' | 'tgCheckedAt'>, now: Date): boolean {
  return !row.tgCountry || !row.tgCheckedAt || now.getTime() - row.tgCheckedAt.getTime() >= COUNTRY_RECHECK_MS
}

/** Error text for the panel: never the proxy credentials. */
export function sanitizeProxyError(err: unknown, proxy: Pick<ProxyEndpoint, 'username' | 'password'>): string {
  let message = err instanceof Error ? err.message : String(err)
  for (const secret of [proxy.password, proxy.username]) if (secret) message = message.replaceAll(secret, '***')
  return message.slice(0, 300)
}

export interface ProxyHealthHooks {
  /** the proxy became dead or expired: accounts on it must stop */
  onDown?: (proxyId: string) => Promise<void> | void
  /** the proxy works again: accounts stopped because of it may resume */
  onUp?: (proxyId: string) => Promise<void> | void
}

export interface ProxyHealth {
  /** maintenance tick: expire overdue proxies, check those that are due */
  checkDue(now?: Date): Promise<number>
  /** check one proxy now, whatever its schedule */
  checkById(id: string): Promise<ProxyStatus | null>
}

export function createProxyHealth(deps: WorkerDeps, checker: ProxyChecker, hooks: ProxyHealthHooks = {}): ProxyHealth {
  const { db, cipher, settings, logger, bus } = deps

  const endpoint = (row: ProxyRow): ProxyEndpoint => ({
    type: row.type,
    host: row.host,
    port: row.port,
    username: row.username,
    password: row.passwordEnc ? cipher.decrypt(row.passwordEnc) : null,
  })

  async function check(row: ProxyRow, now: Date): Promise<ProxyStatus> {
    const proxy = endpoint(row)
    const previous = row.status
    let next: ProxyStatus
    try {
      const latencyMs = await checker.tunnel(proxy)
      const update: Partial<typeof proxies.$inferInsert> = { status: 'ok', latencyMs, lastCheckAt: now, lastOkAt: now, failStreak: 0, lastError: null }
      if (needsCountry(row, now)) {
        try {
          update.tgCountry = await checker.country(proxy)
          update.tgCheckedAt = now
        } catch (err) {
          // the tunnel works: a failed country lookup is not a proxy failure
          logger.warn({ proxyId: row.id, err: sanitizeProxyError(err, proxy) }, 'proxy: country check failed')
        }
      }
      await db.update(proxies).set(update).where(eq(proxies.id, row.id))
      next = 'ok'
    } catch (err) {
      const failStreak = row.failStreak + 1
      next = failStreak >= settings.get('proxy.failThreshold') ? 'dead' : 'failing'
      await db
        .update(proxies)
        .set({ status: next, failStreak, lastCheckAt: now, lastError: sanitizeProxyError(err, proxy) })
        .where(eq(proxies.id, row.id))
    }
    if (next === 'dead' && previous !== 'dead') await hooks.onDown?.(row.id)
    if (next === 'ok' && previous !== 'ok') await hooks.onUp?.(row.id)
    return next
  }

  async function runAll(rows: ProxyRow[], now: Date): Promise<void> {
    const queue = [...rows]
    await Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
        for (let row = queue.shift(); row; row = queue.shift()) {
          await check(row, now).catch((err: unknown) => logger.error({ err, proxyId: row!.id }, 'proxy: check crashed'))
        }
      }),
    )
  }

  return {
    async checkDue(now = new Date()) {
      // overdue paid proxies end here even if the provider still lists them
      const expired = await db
        .update(proxies)
        .set({ status: 'expired' })
        .where(and(lte(proxies.expiresAt, now), ne(proxies.status, 'expired')))
        .returning({ id: proxies.id })
      for (const { id } of expired) await hooks.onDown?.(id)

      const candidates = await db
        .select()
        .from(proxies)
        .where(and(isNull(proxies.disabledAt), notInArray(proxies.status, ['provisioning', 'expired'])))
      const intervalMs = parseDuration(settings.get('proxy.checkInterval'))
      const due = candidates.filter((row) => isDue(row, now, intervalMs))
      await runAll(due, now)
      const changed = [...expired.map((e) => e.id), ...due.map((d) => d.id)]
      if (changed.length > 0) await bus.publish({ type: 'proxies.changed', ids: changed })
      return due.length
    },
    async checkById(id) {
      const [row] = await db.select().from(proxies).where(and(eq(proxies.id, id), notInArray(proxies.status, ['provisioning', 'expired'])))
      if (!row) return null
      const status = await check(row, new Date())
      await bus.publish({ type: 'proxies.changed', ids: [id] })
      return status
    },
  }
}
```

`pnpm-workspace.yaml` — изменения

```diff
--- a/pnpm-workspace.yaml
+++ b/pnpm-workspace.yaml
@@ -12,3 +12,5 @@ allowBuilds:
   protobufjs: false
   # optional native msgpack speedup of bullmq; the pure-JS fallback is used
   msgpackr-extract: false
+  # @mtcute/node's optional sqlite storage; we store sessions in Postgres and it is never loaded
+  better-sqlite3: false
```

- [ ] **Шаг 5: Сгенерировать миграцию**

```bash
fnm exec --using=26 pnpm --filter @workspace/db db:generate --name proxy_country_check
# создаёт packages/db/drizzle/0002_proxy_country_check.sql и снимок в packages/db/drizzle/meta/
```

Сверить сгенерированный SQL с ожидаемым (`packages/db/drizzle/0002_proxy_country_check.sql`):

```sql
ALTER TABLE "proxies" ADD COLUMN "tg_checked_at" timestamp with time zone;
```

- [ ] **Шаг 6: Проверки**

```bash
fnm exec --using=26 pnpm typecheck
fnm exec --using=26 pnpm lint
fnm exec --using=26 npx vitest run --project worker
# всё зелёное
```

- [ ] **Шаг 7: Коммит**

```bash
git add -A
git commit -F - <<'MSG'
feat(worker): proxy health — tunnel check each interval, Telegram-seen country once a day, failing/dead by streak, expiry; proxy.check command
MSG
```

---

### Task 7: Синхронизация с proxy-store

По §6 спеки: `GET https://proxy-store.com/api/{key}/getproxy/`, фильтр `country`/`category`/`active = "1"`, `socks` → `socks5`. `ip = 0.0.0.0` или `port = 0` → `provisioning` (в проверки и выбор не попадает); смена адреса/логина/пароля → обновление, перепроверка и переподключение привязанного аккаунта (`onChanged`); пропавшие и истёкшие → `expired` + `onDown`. Записи `source=manual` не трогаются. Итог последней синхронизации лежит в Redis (`accs:proxy-store:last-sync`), его показывает `GET /api/proxies/sync-status`. API-ключ в тексте ошибок маскируется.

**Files:**
- Modify: `packages/shared/src/proxies.ts`
- Modify: `apps/api/src/routes/proxies.ts`
- Test (modify): `apps/api/test/proxies.test.ts`
- Modify: `apps/worker/src/main.ts`
- Create: `apps/worker/src/proxies/proxy-store.ts`
- Test: `apps/worker/test/proxy-store.test.ts`

**Interfaces:**
- Consumes: `proxies`, `cipher`; `MAINTENANCE_TASKS.proxies.sync` (задача 4); `createProxyHealth().checkById` (задача 6).
- Produces:
  - `packages/shared/src/proxies.ts`: `PROXY_STORE_STATUS_KEY`; `proxyStoreSyncStatus`; `type ProxyStoreSyncStatus`
  - `apps/worker/src/proxies/proxy-store.ts`: `type ProxyStoreItem`; `proxyStoreResponse`; `interface MappedProxy`; `mapProxyStoreList(list: ProxyStoreItem[], filter: { country: string; category: string }): MappedProxy[]`; `type ProxyStoreFetch`; `fetchProxyStoreList(fetchFn: ProxyStoreFetch, apiKey: string): Promise<ProxyStoreItem[]>`; `type SyncResult`; `interface ProxyStoreHooks`; `readSyncStatus(redis: Redis, key = PROXY_STORE_STATUS_KEY): Promise<SyncResult | null>`; `syncProxyStore(`

- [ ] **Шаг 1: Написать падающий тест**

`apps/api/test/proxies.test.ts` — изменения

```diff
--- a/apps/api/test/proxies.test.ts
+++ b/apps/api/test/proxies.test.ts
@@ -100,6 +100,17 @@ describe('proxies api', () => {
     expect((await send(ta.app, `/api/proxies/${loose!.id}`, { cookie, method: 'DELETE' })).status).toBe(404)
   })
 
+  it('shows the last proxy-store sync written by the worker', async () => {
+    expect(await (await send(ta.app, '/api/proxies/sync-status', { cookie })).json()).toEqual({ status: null })
+    const status = { at: '2026-10-03T10:00:00.000Z', ok: false, error: 'proxy-store: bad key', created: 0, updated: 0, expired: 0, skipped: 0 }
+    await ta.deps.redis.set('accs:proxy-store:last-sync', JSON.stringify(status))
+    try {
+      expect(await (await send(ta.app, '/api/proxies/sync-status', { cookie })).json()).toEqual({ status })
+    } finally {
+      await ta.deps.redis.del('accs:proxy-store:last-sync')
+    }
+  })
+
   it('asks the worker to check one proxy or to sync proxy-store', async () => {
     const [p] = await ta.t.db.insert(proxies).values({ source: 'manual', type: 'http', host: '10.2.2.2', port: 80 }).returning()
     ta.commands.sent = []
```

`apps/worker/test/proxy-store.test.ts` — новый файл

```ts
import { accounts, eq, proxies } from '@workspace/db'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mapProxyStoreList, readSyncStatus, syncProxyStore, type ProxyStoreFetch } from '../src/proxies/proxy-store.ts'
import { setupWorker, type TestWorker } from './helpers.ts'

let w: TestWorker
// the api tests read the real status key from the same Redis
let statusKey: string
beforeAll(async () => {
  w = await setupWorker()
  statusKey = `test:proxy-store:${w.deps.queuePrefix}`
})
afterAll(async () => {
  await w.close()
})
beforeEach(async () => {
  await w.t.db.delete(accounts)
  await w.t.db.delete(proxies)
  await w.deps.settings.update({ 'proxyStore.enabled': true, 'proxyStore.apiKey': 'k3y-0123456789abcdef' }, { adminId: null })
})

const END = 1_793_571_000 // 2026-11-02
const item = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  ip: `194.53.188.${id.slice(-2)}`,
  port: '50101',
  user: `user${id}`,
  pass: `pass${id}`,
  type: 'socks',
  country: 'kz',
  category: 'for_all',
  active: '1',
  date: '2026-10-02 00:30:00',
  date_end: '2026-11-02 00:30:00',
  unixtime: END - 2_592_000,
  unixtime_end: END,
  order_id: '900',
  autoprolong: '0',
  comment: '',
  ...over,
})

function fakeFetch(list: unknown) {
  const urls: string[] = []
  const fn: ProxyStoreFetch = vi.fn(async (url: string) => {
    urls.push(url)
    return { ok: true, status: 200, json: async () => ({ status: 'ok', list }) }
  })
  return Object.assign(fn, { urls })
}

it('maps only active proxies of the configured country and category', () => {
  const mapped = mapProxyStoreList(
    [item('5133770'), item('5133763', { type: 'http', port: '50100' }), item('4698704', { country: 'ru', category: 'vkontakte' }), item('5133999', { ip: '0.0.0.0', port: '0', user: '', pass: '' }), item('5133998', { active: '0' })] as never,
    { country: 'kz', category: 'for_all' },
  )
  expect(mapped.map((m) => [m.externalId, m.type, m.provisioning])).toEqual([
    ['5133770', 'socks5', false],
    ['5133763', 'http', false],
    ['5133999', 'socks5', true],
  ])
  expect(mapped[0]).toMatchObject({ host: '194.53.188.70', port: 50101, username: 'user5133770', password: 'pass5133770', expiresAt: new Date(END * 1000) })
})

describe('syncProxyStore', () => {
  it('does nothing while disabled or without an API key', async () => {
    await w.deps.settings.update({ 'proxyStore.enabled': false }, { adminId: null })
    const fetch = fakeFetch({})
    expect(await syncProxyStore(w.deps, fetch, {}, statusKey)).toBeNull()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('adds new proxies, keeps passwords encrypted and leaves manual ones alone', async () => {
    const [manual] = await w.t.db.insert(proxies).values({ source: 'manual', type: 'http', host: '10.9.9.9', port: 80 }).returning()
    const fetch = fakeFetch({ '5133770': item('5133770'), '5133999': item('5133999', { ip: '0.0.0.0', port: '0', user: '', pass: '' }), '4698704': item('4698704', { country: 'ru' }) })
    const result = await syncProxyStore(w.deps, fetch, {}, statusKey)
    expect(result).toMatchObject({ ok: true, created: 2, updated: 0, expired: 0 })
    expect(fetch.urls[0]).toBe('https://proxy-store.com/api/k3y-0123456789abcdef/getproxy/')
    const rows = await w.t.db.select().from(proxies).where(eq(proxies.source, 'proxy_store'))
    expect(rows.map((r) => [r.externalId, r.status]).sort()).toEqual([
      ['5133770', 'unchecked'],
      ['5133999', 'provisioning'],
    ])
    const issued = rows.find((r) => r.externalId === '5133770')!
    expect(w.deps.cipher.decrypt(issued.passwordEnc!)).toBe('pass5133770')
    expect(issued.providerMeta).toEqual({ orderId: '900', autoprolong: false, comment: null })
    expect((await w.t.db.select().from(proxies).where(eq(proxies.id, manual!.id)))[0]!.status).toBe('unchecked')
    expect(await readSyncStatus(w.deps.redis, statusKey)).toMatchObject({ ok: true, created: 2 })
  })

  it('updates changed credentials (reconnecting the bound account) and expires vanished proxies', async () => {
    await syncProxyStore(w.deps, fakeFetch({ '5133770': item('5133770'), '5133771': item('5133771') }), {}, statusKey)
    const rows = await w.t.db.select().from(proxies)
    const changedRow = rows.find((r) => r.externalId === '5133770')!
    const goneRow = rows.find((r) => r.externalId === '5133771')!
    await w.t.db.update(proxies).set({ status: 'ok', tgCountry: 'KZ' }).where(eq(proxies.id, changedRow.id))

    const onChanged = vi.fn()
    const onDown = vi.fn()
    const result = await syncProxyStore(w.deps, fakeFetch({ '5133770': item('5133770', { ip: '194.53.188.99', pass: 'rotated' }) }), { onChanged, onDown }, statusKey)
    expect(result).toMatchObject({ ok: true, created: 0, updated: 1, expired: 1 })
    const after = (await w.t.db.select().from(proxies).where(eq(proxies.id, changedRow.id)))[0]!
    expect(after).toMatchObject({ host: '194.53.188.99', status: 'unchecked', tgCountry: null, lastCheckAt: null })
    expect(w.deps.cipher.decrypt(after.passwordEnc!)).toBe('rotated')
    expect(onChanged).toHaveBeenCalledExactlyOnceWith(changedRow.id)
    expect((await w.t.db.select().from(proxies).where(eq(proxies.id, goneRow.id)))[0]!.status).toBe('expired')
    expect(onDown).toHaveBeenCalledExactlyOnceWith(goneRow.id)
  })

  it('records a failed sync without leaking the API key', async () => {
    const failing: ProxyStoreFetch = async () => {
      throw new Error('getaddrinfo ENOTFOUND for https://proxy-store.com/api/k3y-0123456789abcdef/getproxy/')
    }
    const result = await syncProxyStore(w.deps, failing, {}, statusKey)
    expect(result).toMatchObject({ ok: false, error: 'getaddrinfo ENOTFOUND for https://proxy-store.com/api/***/getproxy/' })
    expect(JSON.stringify(await readSyncStatus(w.deps.redis, statusKey))).not.toContain('k3y-0123456789abcdef')
  })
})
```

- [ ] **Шаг 2: Убедиться, что тест падает**

```bash
fnm exec --using=26 npx vitest run --project worker apps/worker/test/proxy-store.test.ts
# FAIL: Cannot find module '../src/proxies/proxy-store.ts'
```

- [ ] **Шаг 3: Реализация**

`packages/shared/src/proxies.ts` — изменения

```diff
--- a/packages/shared/src/proxies.ts
+++ b/packages/shared/src/proxies.ts
@@ -187,3 +187,18 @@ export type ImportProxiesPreview = z.output<typeof importProxiesPreview>
 
 export const importProxiesResult = z.object({ created: z.number(), skipped: z.number() })
 export type ImportProxiesResult = z.output<typeof importProxiesResult>
+
+// ---- proxy-store sync status (written by the worker, read by the api) ----
+
+export const PROXY_STORE_STATUS_KEY = 'accs:proxy-store:last-sync'
+
+export const proxyStoreSyncStatus = z.object({
+  at: z.string(),
+  ok: z.boolean(),
+  error: z.string().optional(),
+  created: z.number(),
+  updated: z.number(),
+  expired: z.number(),
+  skipped: z.number(),
+})
+export type ProxyStoreSyncStatus = z.output<typeof proxyStoreSyncStatus>
```

`apps/api/src/routes/proxies.ts` — изменения

```diff
--- a/apps/api/src/routes/proxies.ts
+++ b/apps/api/src/routes/proxies.ts
@@ -1,5 +1,5 @@
 import { zValidator } from '@hono/zod-validator'
-import { createProxyInput, importProxiesInput, updateProxyInput } from '@workspace/shared/proxies'
+import { createProxyInput, importProxiesInput, PROXY_STORE_STATUS_KEY, proxyStoreSyncStatus, updateProxyInput } from '@workspace/shared/proxies'
 import { Hono } from 'hono'
 import { z } from 'zod'
 import type { AppEnv } from '../deps.ts'
@@ -11,6 +11,12 @@ const idParam = z.object({ id: z.uuid() })
 
 export const proxyRoutes = new Hono<AppEnv>()
   .get('/proxies', async (c) => c.json({ items: await listProxies(c.get('deps').db) }))
+  /** last proxy-store sync (null until the worker has run one) */
+  .get('/proxies/sync-status', async (c) => {
+    const raw = await c.get('deps').redis.get(PROXY_STORE_STATUS_KEY)
+    const parsed = raw ? proxyStoreSyncStatus.safeParse(JSON.parse(raw)) : null
+    return c.json({ status: parsed?.success ? parsed.data : null })
+  })
   .post('/proxies', audited('proxy.create'), zValidator('json', createProxyInput, validationHook), async (c) => {
     const { db, cipher, commands, bus } = c.get('deps')
     const proxy = await createProxy(db, cipher, c.req.valid('json'))
```

`apps/worker/src/main.ts` — изменения

```diff
--- a/apps/worker/src/main.ts
+++ b/apps/worker/src/main.ts
@@ -6,6 +6,7 @@ import type { WorkerDeps } from './deps.ts'
 import { acquireSingletonLock } from './lock.ts'
 import { createMtcuteProxyChecker } from './proxies/checker.ts'
 import { createProxyHealth } from './proxies/health.ts'
+import { syncProxyStore } from './proxies/proxy-store.ts'
 import { createWorkerRuntime } from './runtime.ts'
 
 const env = loadEnv()
@@ -37,11 +38,15 @@ const proxyHealth = createProxyHealth(deps, proxyChecker)
 const runtime = createWorkerRuntime(deps, {
   commands: {
     'proxy.check': async ({ proxyId }) => proxyHealth.checkById(proxyId),
+    'proxy.sync': async () => syncProxyStore(deps, fetch),
   },
   maintenance: {
     'proxies.checkDue': async () => {
       await proxyHealth.checkDue()
     },
+    'proxies.sync': async () => {
+      await syncProxyStore(deps, fetch)
+    },
   },
 })
 await runtime.start()
```

`apps/worker/src/proxies/proxy-store.ts` — новый файл

```ts
import { eq, proxies } from '@workspace/db'
import type { Redis } from '@workspace/server'
import { PROXY_STORE_STATUS_KEY, proxyEndpointKey, proxyStoreSyncStatus, type ProxyStoreSyncStatus } from '@workspace/shared/proxies'
import { z } from 'zod'
import type { WorkerDeps } from '../deps.ts'

const itemSchema = z.object({
  id: z.coerce.string(),
  ip: z.string(),
  port: z.coerce.string(),
  user: z.string().nullish(),
  pass: z.string().nullish(),
  type: z.string(),
  country: z.string(),
  category: z.string().nullish(),
  active: z.coerce.string(),
  unixtime_end: z.coerce.number().nullish(),
  order_id: z.coerce.string().nullish(),
  autoprolong: z.coerce.string().nullish(),
  comment: z.string().nullish(),
})
export type ProxyStoreItem = z.output<typeof itemSchema>

/** `{ status: 'ok', list: { "<id>": {...} } }`; an empty list may come as `[]`. */
export const proxyStoreResponse = z.object({
  status: z.string(),
  list: z.union([z.record(z.string(), itemSchema), z.array(itemSchema)]).optional(),
  error: z.string().optional(),
})

export interface MappedProxy {
  externalId: string
  type: 'socks5' | 'http'
  host: string
  port: number
  username: string | null
  password: string | null
  /** bought but not issued yet: ip 0.0.0.0 / port 0 */
  provisioning: boolean
  expiresAt: Date | null
  meta: { orderId: string | null; autoprolong: boolean; comment: string | null }
}

/** Active proxies of the configured country and category, in our terms. */
export function mapProxyStoreList(list: ProxyStoreItem[], filter: { country: string; category: string }): MappedProxy[] {
  return list
    .filter((p) => p.active === '1' && p.country.toLowerCase() === filter.country && (p.category ?? '') === filter.category)
    .filter((p) => p.type === 'socks' || p.type === 'http')
    .map((p) => {
      const port = Number(p.port)
      return {
        externalId: p.id,
        type: p.type === 'socks' ? 'socks5' : 'http',
        host: p.ip,
        port,
        username: p.user || null,
        password: p.pass || null,
        provisioning: p.ip === '0.0.0.0' || port === 0,
        expiresAt: p.unixtime_end ? new Date(p.unixtime_end * 1000) : null,
        meta: { orderId: p.order_id ?? null, autoprolong: p.autoprolong === '1', comment: p.comment || null },
      }
    })
}

export type ProxyStoreFetch = (url: string, init: { signal: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>

export async function fetchProxyStoreList(fetchFn: ProxyStoreFetch, apiKey: string): Promise<ProxyStoreItem[]> {
  const res = await fetchFn(`https://proxy-store.com/api/${encodeURIComponent(apiKey)}/getproxy/`, { signal: AbortSignal.timeout(20_000) })
  if (!res.ok) throw new Error(`proxy-store answered HTTP ${res.status}`)
  const body = proxyStoreResponse.parse(await res.json())
  if (body.status !== 'ok') throw new Error(`proxy-store: ${body.error ?? body.status}`)
  if (!body.list) return []
  return Array.isArray(body.list) ? body.list : Object.values(body.list)
}

export type SyncResult = ProxyStoreSyncStatus

export interface ProxyStoreHooks {
  /** a bound proxy changed address or credentials: its account must reconnect */
  onChanged?: (proxyId: string) => Promise<void> | void
  /** a proxy vanished from the provider: accounts on it stop */
  onDown?: (proxyId: string) => Promise<void> | void
}

/** Last sync outcome (the api shows it on the proxies page). */
export async function readSyncStatus(redis: Redis, key = PROXY_STORE_STATUS_KEY): Promise<SyncResult | null> {
  const raw = await redis.get(key)
  return raw ? proxyStoreSyncStatus.parse(JSON.parse(raw)) : null
}

/**
 * Brings `source = 'proxy_store'` rows in line with the provider. Manual proxies are never touched.
 * Returns null when the sync is off or has no API key.
 */
export async function syncProxyStore(
  deps: WorkerDeps,
  fetchFn: ProxyStoreFetch,
  hooks: ProxyStoreHooks = {},
  /** tests sharing one Redis pass their own key */
  statusKey = PROXY_STORE_STATUS_KEY,
): Promise<SyncResult | null> {
  const { db, cipher, settings, logger, bus, redis } = deps
  const apiKey = settings.get('proxyStore.apiKey')
  if (!settings.get('proxyStore.enabled') || !apiKey) return null

  const result: SyncResult = { at: new Date().toISOString(), ok: true, created: 0, updated: 0, expired: 0, skipped: 0 }
  const changedIds: string[] = []
  try {
    const items = await fetchProxyStoreList(fetchFn, apiKey)
    const wanted = mapProxyStoreList(items, { country: settings.get('proxyStore.country'), category: settings.get('proxyStore.category') })
    const existing = await db.select().from(proxies).where(eq(proxies.source, 'proxy_store'))
    const byExternalId = new Map(existing.map((row) => [row.externalId, row]))
    const manualEndpoints = new Set(
      (await db.select().from(proxies).where(eq(proxies.source, 'manual'))).map((row) => proxyEndpointKey(row)),
    )

    for (const p of wanted) {
      const row = byExternalId.get(p.externalId)
      byExternalId.delete(p.externalId)
      const issuedStatus = p.provisioning ? ('provisioning' as const) : ('unchecked' as const)
      if (!row) {
        if (!p.provisioning && manualEndpoints.has(proxyEndpointKey(p))) {
          result.skipped++
          continue
        }
        const [inserted] = await db
          .insert(proxies)
          .values({
            source: 'proxy_store',
            externalId: p.externalId,
            type: p.type,
            host: p.host,
            port: p.port,
            username: p.username,
            passwordEnc: p.password ? cipher.encrypt(p.password) : null,
            status: issuedStatus,
            expiresAt: p.expiresAt,
            providerMeta: p.meta,
          })
          .onConflictDoNothing()
          .returning({ id: proxies.id })
        if (inserted) {
          result.created++
          changedIds.push(inserted.id)
        } else result.skipped++
        continue
      }
      const password = row.passwordEnc ? cipher.decrypt(row.passwordEnc) : null
      const endpointChanged = row.type !== p.type || row.host !== p.host || row.port !== p.port || row.username !== p.username || password !== p.password
      const renewed = row.status === 'expired' && (!p.expiresAt || p.expiresAt > new Date())
      if (endpointChanged || renewed) {
        await db
          .update(proxies)
          .set({
            type: p.type,
            host: p.host,
            port: p.port,
            username: p.username,
            passwordEnc: p.password ? cipher.encrypt(p.password) : null,
            status: issuedStatus,
            failStreak: 0,
            lastCheckAt: null,
            lastError: null,
            ...(endpointChanged ? { tgCountry: null, tgCheckedAt: null, latencyMs: null } : {}),
            expiresAt: p.expiresAt,
            providerMeta: p.meta,
          })
          .where(eq(proxies.id, row.id))
        result.updated++
        changedIds.push(row.id)
        if (endpointChanged) await hooks.onChanged?.(row.id)
      } else if (row.expiresAt?.getTime() !== p.expiresAt?.getTime()) {
        await db.update(proxies).set({ expiresAt: p.expiresAt, expiryWarnedAt: null, providerMeta: p.meta }).where(eq(proxies.id, row.id))
        changedIds.push(row.id)
      }
    }

    // gone from the provider (cancelled, not renewed): expired; accounts on it stop
    for (const row of byExternalId.values()) {
      if (row.status === 'expired') continue
      await db.update(proxies).set({ status: 'expired' }).where(eq(proxies.id, row.id))
      result.expired++
      changedIds.push(row.id)
      await hooks.onDown?.(row.id)
    }
  } catch (err) {
    result.ok = false
    // the API key is part of the URL: never let it reach the log or the panel
    result.error = (err instanceof Error ? err.message : String(err)).replaceAll(apiKey, '***').slice(0, 300)
    logger.warn({ error: result.error }, 'proxy-store: sync failed')
  }
  await redis.set(statusKey, JSON.stringify(result))
  if (changedIds.length > 0) await bus.publish({ type: 'proxies.changed', ids: changedIds })
  return result
}
```

- [ ] **Шаг 4: Проверки**

```bash
fnm exec --using=26 pnpm typecheck
fnm exec --using=26 pnpm lint
fnm exec --using=26 npx vitest run --project api --project worker
# всё зелёное
```

- [ ] **Шаг 5: Коммит**

```bash
git add -A
git commit -F - <<'MSG'
feat(worker): proxy-store sync — kz/for_all filter, provisioning, credential changes, expiry of vanished proxies; last sync status for the panel
MSG
```

---

### Task 8: Web: страница «Прокси»

Таблица пула: статус (текст ошибки — в tooltip), тип и адрес, задержка, страна глазами Telegram, источник, срок, привязанный аккаунт; фильтры по статусу и источнику, поиск. «Добавить» и «Импорт списка» (предпросмотр: новые, ошибки по строкам, повторы; закрытие диалога забывает введённые пароли), «Синхронизировать», «Проверить», отключение и удаление. Список обновляется по событию `proxies.changed`.

`api()` теперь возвращает `undefined` для любого пустого ответа: `check`/`sync` отвечают 202 без тела, и `res.json()` на них падал.

**Files:**
- Create: `apps/web/src/components/proxies/add-proxy-dialog.tsx`
- Test: `apps/web/src/components/proxies/import-proxies-dialog.test.tsx`
- Create: `apps/web/src/components/proxies/import-proxies-dialog.tsx`
- Create: `apps/web/src/components/proxies/proxy-status-badge.tsx`
- Create: `apps/web/src/components/proxies/proxy-type-select.tsx`
- Test: `apps/web/src/lib/api.test.ts`
- Modify: `apps/web/src/lib/api.ts`
- Test: `apps/web/src/lib/format.test.ts`
- Modify: `apps/web/src/lib/format.ts`
- Create: `apps/web/src/lib/proxies.ts`
- Modify: `apps/web/src/routes/_authed.tsx`
- Modify: `apps/web/src/routes/_authed/proxies.tsx`

**Interfaces:**
- Consumes: `/api/proxies*` (задачи 5, 7); `ProxyDto`, `proxyStatusLabels` (задача 2); `DataTable`, `PageHeader`, `titleHead` (план 1).
- Produces:
  - `apps/web/src/components/proxies/add-proxy-dialog.tsx`: `AddProxyDialog()`
  - `apps/web/src/components/proxies/import-proxies-dialog.tsx`: `ImportProxiesDialog()`
  - `apps/web/src/components/proxies/proxy-status-badge.tsx`: `ProxyStatusBadge({ status }: { status: ProxyStatus })`
  - `apps/web/src/components/proxies/proxy-type-select.tsx`: `ProxyTypeSelect({ id, value, onChange }: { id: string; value: ProxyType; onChange: (value: ProxyType) => void })`
  - `apps/web/src/lib/format.ts`: `formatRelative(iso: string | null | undefined, now = Date.now()): string`; `formatDate(iso: string | null | undefined): string`
  - `apps/web/src/lib/proxies.ts`: `proxiesQueryOptions`; `proxySyncStatusQueryOptions`; `proxyStatusVariant: Record<ProxyStatus, 'secondary' | 'outline' | 'destructive'>`; `PROXY_STATUS_FILTERS`; `type ProxyStatusFilter`

- [ ] **Шаг 1: Написать падающий тест**

`apps/web/src/components/proxies/import-proxies-dialog.test.tsx` — новый файл

```tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Toaster } from '@workspace/ui/components/toast'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ImportProxiesDialog } from './import-proxies-dialog'

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

afterEach(() => vi.unstubAllGlobals())

function renderDialog() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <Toaster>
        <ImportProxiesDialog />
      </Toaster>
    </QueryClientProvider>,
  )
}

describe('ImportProxiesDialog', () => {
  it('previews the pasted list, shows problems by line and imports only after confirmation', async () => {
    const fetchMock = vi.fn(async (url: string) =>
      url.endsWith('/preview')
        ? json({
            proxies: [{ line: 1, type: 'socks5', host: '194.53.188.22', port: 50101, username: 'kz1' }],
            errors: [{ line: 2, text: 'garbage', reason: 'Ожидается host:port' }],
            duplicates: [{ line: 3, text: '1.1.1.1:80', reason: 'exists' }],
          })
        : json({ created: 1, skipped: 0 }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const user = userEvent.setup()
    renderDialog()

    await user.click(screen.getByRole('button', { name: 'Импорт списка' }))
    await user.type(screen.getByLabelText('Список'), 'socks5://kz1:pw@194.53.188.22:50101{enter}garbage{enter}1.1.1.1:80')
    await user.click(screen.getByRole('button', { name: 'Проверить список' }))

    expect(await screen.findByText('Новых: 1')).toBeInTheDocument()
    expect(screen.getByText('строка 2: Ожидается host:port')).toBeInTheDocument()
    expect(screen.getByText('строка 3: уже в пуле')).toBeInTheDocument()
    expect(fetchMock).toHaveBeenCalledTimes(1)

    await user.click(screen.getByRole('button', { name: 'Добавить 1' }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    const [url, init] = fetchMock.mock.calls[1] as unknown as [string, RequestInit]
    expect(url).toBe('/api/proxies/import')
    expect(JSON.parse(String(init.body))).toEqual({ text: 'socks5://kz1:pw@194.53.188.22:50101\ngarbage\n1.1.1.1:80', defaultType: 'socks5' })
    expect(await screen.findByText('Добавлено прокси: 1')).toBeInTheDocument()
  })

  it('forgets the pasted list (with passwords) when closed', async () => {
    vi.stubGlobal('fetch', vi.fn())
    const user = userEvent.setup()
    renderDialog()
    await user.click(screen.getByRole('button', { name: 'Импорт списка' }))
    await user.type(screen.getByLabelText('Список'), 'u:secret@1.1.1.1:80')
    await user.keyboard('{Escape}')
    await user.click(screen.getByRole('button', { name: 'Импорт списка' }))
    expect(screen.getByLabelText('Список')).toHaveValue('')
  })
})
```

`apps/web/src/lib/api.test.ts` — новый файл

```ts
import { afterEach, describe, expect, it, vi } from 'vitest'
import { api, ApiError } from './api'

afterEach(() => vi.unstubAllGlobals())

describe('api', () => {
  it('returns parsed JSON, and undefined for empty answers such as 202 Accepted', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(null, { status: 202 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(api('/x')).resolves.toEqual({ ok: true })
    await expect(api('/x', { method: 'POST' })).resolves.toBeUndefined()
    await expect(api('/x', { method: 'DELETE' })).resolves.toBeUndefined()
  })

  it('throws ApiError with the server message', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{"error":"not_running","message":"Аккаунт не подключён"}', { status: 409 })))
    const err = await api('/x').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect((err as ApiError).message).toBe('Аккаунт не подключён')
  })
})
```

`apps/web/src/lib/format.test.ts` — новый файл

```ts
import { expect, it } from 'vitest'
import { formatRelative } from './format'

it('formats times relative to now in Russian', () => {
  const now = Date.parse('2026-10-03T12:00:00Z')
  expect(formatRelative('2026-10-03T11:55:00Z', now)).toBe('5 минут назад')
  expect(formatRelative('2026-10-03T12:00:00Z', now)).toBe('сейчас')
  expect(formatRelative('2026-10-06T12:00:00Z', now)).toBe('через 3 дня')
  expect(formatRelative(null, now)).toBe('—')
})
```

- [ ] **Шаг 2: Убедиться, что тест падает**

```bash
fnm exec --using=26 npx vitest run --project web apps/web/src/lib/api.test.ts apps/web/src/lib/format.test.ts apps/web/src/components/proxies
# FAIL: модулей ещё нет; api.test — SyntaxError на ответе 202
```

- [ ] **Шаг 3: Реализация**

`apps/web/src/components/proxies/add-proxy-dialog.tsx` — новый файл

```tsx
import * as React from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { ProxyType } from '@workspace/shared/proxies'
import { Button } from '@workspace/ui/components/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@workspace/ui/components/dialog'
import { Field, FieldError, FieldGroup, FieldLabel } from '@workspace/ui/components/field'
import { Input } from '@workspace/ui/components/input'
import { Spinner } from '@workspace/ui/components/spinner'
import { toast } from '@workspace/ui/components/toast'
import { PlusIcon } from 'lucide-react'
import { PasswordInput } from '@/components/password-input'
import { api, ApiError } from '@/lib/api'
import { proxiesQueryOptions } from '@/lib/proxies'
import { ProxyTypeSelect } from './proxy-type-select'

const empty = { type: 'socks5' as ProxyType, host: '', port: '', username: '', password: '', tag: '' }

export function AddProxyDialog() {
  const queryClient = useQueryClient()
  const [open, setOpen] = React.useState(false)
  const [form, setForm] = React.useState(empty)
  const set = (patch: Partial<typeof empty>) => setForm((f) => ({ ...f, ...patch }))
  const mutation = useMutation({
    mutationFn: () =>
      api('/proxies', {
        method: 'POST',
        json: {
          type: form.type,
          host: form.host,
          port: form.port,
          ...(form.username ? { username: form.username } : {}),
          ...(form.password ? { password: form.password } : {}),
          ...(form.tag ? { tag: form.tag } : {}),
        },
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: proxiesQueryOptions.queryKey })
      toast.add({ title: 'Прокси добавлен', description: `${form.host}:${form.port} — проверка запущена` })
      handleOpenChange(false)
    },
    onError: (err) => {
      if (!(err instanceof ApiError) || (err.status !== 400 && err.status !== 409)) {
        toast.add({ title: 'Не удалось добавить прокси', description: err instanceof Error ? err.message : String(err) })
      }
    },
  })
  const err = mutation.error instanceof ApiError ? mutation.error : null
  const fields = err?.fields ?? {}
  const hostError = fields.host ?? (err?.status === 409 ? err.message : undefined)

  function handleOpenChange(next: boolean) {
    // never keep a typed password after the dialog closes
    if (!next) {
      setForm(empty)
      mutation.reset()
    }
    setOpen(next)
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger render={<Button />}>
        <PlusIcon data-icon="inline-start" />
        Добавить
      </DialogTrigger>
      <DialogContent>
        <form
          className="flex flex-col gap-6"
          onSubmit={(e) => {
            e.preventDefault()
            mutation.mutate()
          }}
        >
          <DialogHeader>
            <DialogTitle>Новый прокси</DialogTitle>
            <DialogDescription>Сразу после добавления прокси проверяется подключением к Telegram.</DialogDescription>
          </DialogHeader>
          <FieldGroup>
            <div className="grid grid-cols-[8rem_1fr_6rem] gap-3">
              <Field>
                <FieldLabel htmlFor="proxy-type">Тип</FieldLabel>
                <ProxyTypeSelect id="proxy-type" value={form.type} onChange={(type) => set({ type })} />
              </Field>
              <Field data-invalid={hostError ? true : undefined}>
                <FieldLabel htmlFor="proxy-host">Адрес</FieldLabel>
                <Input id="proxy-host" required placeholder="194.53.188.22" value={form.host} onChange={(e) => set({ host: e.target.value })} aria-invalid={hostError ? true : undefined} />
              </Field>
              <Field data-invalid={fields.port ? true : undefined}>
                <FieldLabel htmlFor="proxy-port">Порт</FieldLabel>
                <Input id="proxy-port" required inputMode="numeric" value={form.port} onChange={(e) => set({ port: e.target.value })} aria-invalid={fields.port ? true : undefined} />
              </Field>
            </div>
            {(hostError || fields.port) && <FieldError>{hostError ?? fields.port}</FieldError>}
            <div className="grid grid-cols-2 gap-3">
              <Field>
                <FieldLabel htmlFor="proxy-username">Логин</FieldLabel>
                <Input id="proxy-username" autoComplete="off" value={form.username} onChange={(e) => set({ username: e.target.value })} />
              </Field>
              <Field>
                <FieldLabel htmlFor="proxy-password">Пароль</FieldLabel>
                <PasswordInput id="proxy-password" autoComplete="new-password" value={form.password} onChange={(e) => set({ password: e.target.value })} />
              </Field>
            </div>
            <Field>
              <FieldLabel htmlFor="proxy-tag">Метка</FieldLabel>
              <Input id="proxy-tag" placeholder="необязательно" value={form.tag} onChange={(e) => set({ tag: e.target.value })} />
            </Field>
          </FieldGroup>
          <DialogFooter>
            <Button type="submit" disabled={mutation.isPending}>
              {mutation.isPending && <Spinner data-icon="inline-start" />}
              Добавить
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
```

`apps/web/src/components/proxies/import-proxies-dialog.tsx` — новый файл

```tsx
import * as React from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { ImportProxiesPreview, ImportProxiesResult, ProxyType } from '@workspace/shared/proxies'
import { Alert, AlertDescription, AlertTitle } from '@workspace/ui/components/alert'
import { Badge } from '@workspace/ui/components/badge'
import { Button } from '@workspace/ui/components/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@workspace/ui/components/dialog'
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@workspace/ui/components/field'
import { Input } from '@workspace/ui/components/input'
import { Spinner } from '@workspace/ui/components/spinner'
import { Textarea } from '@workspace/ui/components/textarea'
import { toast } from '@workspace/ui/components/toast'
import { ListPlusIcon } from 'lucide-react'
import { api, ApiError } from '@/lib/api'
import { proxiesQueryOptions } from '@/lib/proxies'
import { ProxyTypeSelect } from './proxy-type-select'

const SHOWN_PROBLEMS = 8

export function ImportProxiesDialog() {
  const queryClient = useQueryClient()
  const [open, setOpen] = React.useState(false)
  const [text, setText] = React.useState('')
  const [defaultType, setDefaultType] = React.useState<ProxyType>('socks5')
  const [tag, setTag] = React.useState('')
  const body = () => ({ text, defaultType, ...(tag ? { tag } : {}) })

  const preview = useMutation({ mutationFn: () => api<ImportProxiesPreview>('/proxies/import/preview', { method: 'POST', json: body() }) })
  const commit = useMutation({
    mutationFn: () => api<ImportProxiesResult>('/proxies/import', { method: 'POST', json: body() }),
    onSuccess: async (result) => {
      await queryClient.invalidateQueries({ queryKey: proxiesQueryOptions.queryKey })
      toast.add({ title: `Добавлено прокси: ${result.created}`, description: result.skipped ? `Пропущено: ${result.skipped}` : 'Проверка начнётся в течение минуты' })
      handleOpenChange(false)
    },
    onError: (err) => toast.add({ title: 'Не удалось импортировать', description: err instanceof ApiError ? err.message : String(err) }),
  })

  function handleOpenChange(next: boolean) {
    // the pasted list carries passwords: drop it when the dialog closes
    if (!next) {
      setText('')
      setTag('')
      preview.reset()
      commit.reset()
    }
    setOpen(next)
  }

  const result = preview.data
  const problems = result ? [...result.errors.map((e) => ({ ...e, kind: e.reason })), ...result.duplicates.map((d) => ({ ...d, kind: d.reason === 'exists' ? 'уже в пуле' : 'повтор в списке' }))].sort((a, b) => a.line - b.line) : []

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger render={<Button variant="outline" />}>
        <ListPlusIcon data-icon="inline-start" />
        Импорт списка
      </DialogTrigger>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Импорт списка прокси</DialogTitle>
          <DialogDescription>По одному на строку: socks5://логин:пароль@host:port, http://host:port, host:port, host:port:логин:пароль или логин:пароль@host:port.</DialogDescription>
        </DialogHeader>
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="proxy-import-text">Список</FieldLabel>
            <Textarea
              id="proxy-import-text"
              className="min-h-40 font-mono text-xs"
              spellCheck={false}
              value={text}
              onChange={(e) => {
                setText(e.target.value)
                preview.reset()
              }}
            />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field>
              <FieldLabel htmlFor="proxy-import-type">Тип для строк без схемы</FieldLabel>
              <ProxyTypeSelect
                id="proxy-import-type"
                value={defaultType}
                onChange={(t) => {
                  setDefaultType(t)
                  preview.reset()
                }}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="proxy-import-tag">Метка</FieldLabel>
              <Input id="proxy-import-tag" placeholder="необязательно" value={tag} onChange={(e) => setTag(e.target.value)} />
              <FieldDescription>Достанется всем прокси из этого списка.</FieldDescription>
            </Field>
          </div>
        </FieldGroup>
        {result && (
          <Alert variant={result.proxies.length ? 'default' : 'destructive'}>
            <AlertTitle className="flex flex-wrap items-center gap-2">
              Новых: {result.proxies.length}
              {result.errors.length > 0 && <Badge variant="destructive">ошибок: {result.errors.length}</Badge>}
              {result.duplicates.length > 0 && <Badge variant="outline">дублей: {result.duplicates.length}</Badge>}
            </AlertTitle>
            {problems.length > 0 && (
              <AlertDescription>
                <ul className="flex flex-col gap-1 font-mono text-xs">
                  {problems.slice(0, SHOWN_PROBLEMS).map((p) => (
                    <li key={`${p.line}-${p.kind}`}>
                      строка {p.line}: {p.kind}
                    </li>
                  ))}
                  {problems.length > SHOWN_PROBLEMS && <li>… и ещё {problems.length - SHOWN_PROBLEMS}</li>}
                </ul>
              </AlertDescription>
            )}
          </Alert>
        )}
        <DialogFooter>
          {result && result.proxies.length > 0 ? (
            <Button disabled={commit.isPending} onClick={() => commit.mutate()}>
              {commit.isPending && <Spinner data-icon="inline-start" />}
              Добавить {result.proxies.length}
            </Button>
          ) : (
            <Button disabled={!text.trim() || preview.isPending} onClick={() => preview.mutate()}>
              {preview.isPending && <Spinner data-icon="inline-start" />}
              Проверить список
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
```

`apps/web/src/components/proxies/proxy-status-badge.tsx` — новый файл

```tsx
import { proxyStatusLabels, type ProxyStatus } from '@workspace/shared/proxies'
import { Badge } from '@workspace/ui/components/badge'
import { proxyStatusVariant } from '@/lib/proxies'

export function ProxyStatusBadge({ status }: { status: ProxyStatus }) {
  return <Badge variant={proxyStatusVariant[status]}>{proxyStatusLabels[status]}</Badge>
}
```

`apps/web/src/components/proxies/proxy-type-select.tsx` — новый файл

```tsx
import type { ProxyType } from '@workspace/shared/proxies'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@workspace/ui/components/select'

const items = [
  { value: 'socks5', label: 'SOCKS5' },
  { value: 'http', label: 'HTTP' },
] as const

export function ProxyTypeSelect({ id, value, onChange }: { id: string; value: ProxyType; onChange: (value: ProxyType) => void }) {
  return (
    <Select items={items} value={value} onValueChange={(v) => v && onChange(v as ProxyType)}>
      <SelectTrigger id={id} className="w-full">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          {items.map((item) => (
            <SelectItem key={item.value} value={item.value}>
              {item.label}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  )
}
```

`apps/web/src/lib/api.ts` — изменения

```diff
--- a/apps/web/src/lib/api.ts
+++ b/apps/web/src/lib/api.ts
@@ -30,6 +30,7 @@ export async function api<T>(path: string, init: RequestInit & { json?: unknown
     }
     throw new ApiError(res.status, body)
   }
-  if (res.status === 204) return undefined as T
-  return (await res.json()) as T
+  // 202/204 and other empty answers carry no JSON
+  const text = await res.text()
+  return (text ? JSON.parse(text) : undefined) as T
 }
```

`apps/web/src/lib/format.ts` — изменения

```diff
--- a/apps/web/src/lib/format.ts
+++ b/apps/web/src/lib/format.ts
@@ -3,3 +3,30 @@ const dateTime = new Intl.DateTimeFormat('ru-RU', { dateStyle: 'short', timeStyl
 export function formatDateTime(iso: string | null | undefined): string {
   return iso ? dateTime.format(new Date(iso)) : '—'
 }
+
+const relative = new Intl.RelativeTimeFormat('ru-RU', { numeric: 'auto' })
+const RELATIVE_STEPS: [Intl.RelativeTimeFormatUnit, number][] = [
+  ['second', 60],
+  ['minute', 60],
+  ['hour', 24],
+  ['day', 30],
+  ['month', 12],
+  ['year', Infinity],
+]
+
+/** «5 минут назад», «через 3 дня»; `now` is for tests. */
+export function formatRelative(iso: string | null | undefined, now = Date.now()): string {
+  if (!iso) return '—'
+  let value = (new Date(iso).getTime() - now) / 1000
+  for (const [unit, size] of RELATIVE_STEPS) {
+    if (Math.abs(value) < size) return relative.format(Math.round(value), unit)
+    value /= size
+  }
+  return '—'
+}
+
+const dateOnly = new Intl.DateTimeFormat('ru-RU', { dateStyle: 'medium' })
+
+export function formatDate(iso: string | null | undefined): string {
+  return iso ? dateOnly.format(new Date(iso)) : '—'
+}
```

`apps/web/src/lib/proxies.ts` — новый файл

```ts
import { queryOptions } from '@tanstack/react-query'
import type { ProxyDto, ProxyStatus, ProxyStoreSyncStatus } from '@workspace/shared/proxies'
import { api } from './api'

export const proxiesQueryOptions = queryOptions({
  queryKey: ['proxies'] as const,
  queryFn: ({ signal }) => api<{ items: ProxyDto[] }>('/proxies', { signal }),
})

export const proxySyncStatusQueryOptions = queryOptions({
  queryKey: ['proxies', 'sync-status'] as const,
  queryFn: ({ signal }) => api<{ status: ProxyStoreSyncStatus | null }>('/proxies/sync-status', { signal }),
})

export const proxyStatusVariant: Record<ProxyStatus, 'secondary' | 'outline' | 'destructive'> = {
  ok: 'secondary',
  unchecked: 'outline',
  provisioning: 'outline',
  failing: 'outline',
  dead: 'destructive',
  expired: 'destructive',
}

/** Bound proxies first among equals: the filter groups of the proxies page. */
export const PROXY_STATUS_FILTERS = {
  all: null,
  ok: ['ok'],
  problems: ['failing', 'dead'],
  other: ['unchecked', 'provisioning', 'expired'],
} as const satisfies Record<string, readonly ProxyStatus[] | null>
export type ProxyStatusFilter = keyof typeof PROXY_STATUS_FILTERS
```

`apps/web/src/routes/_authed.tsx` — изменения

```diff
--- a/apps/web/src/routes/_authed.tsx
+++ b/apps/web/src/routes/_authed.tsx
@@ -3,6 +3,7 @@ import { createFileRoute, Outlet, redirect } from '@tanstack/react-router'
 import { toast } from '@workspace/ui/components/toast'
 import { AppHeader } from '@/components/app-header'
 import { meQueryOptions, recheckSession } from '@/lib/auth'
+import { proxiesQueryOptions } from '@/lib/proxies'
 import { settingsQueryOptions } from '@/lib/settings'
 import { useEventStream } from '@/lib/use-event-stream'
 
@@ -24,6 +25,7 @@ function AuthedLayout() {
         void queryClient.invalidateQueries({ queryKey: settingsQueryOptions.queryKey })
         if (event.by !== me.id) toast.add({ title: 'Настройки изменены', description: 'Другой админ или CLI обновил настройки.' })
       }
+      if (event.type === 'proxies.changed') void queryClient.invalidateQueries({ queryKey: proxiesQueryOptions.queryKey })
     },
     // a revoked session ends at the global 401 handler (→ /login)
     onSessionLost: () => void recheckSession(queryClient),
```

`apps/web/src/routes/_authed/proxies.tsx` — заменить содержимое целиком

```tsx
import * as React from 'react'
import { useMutation, useQueryClient, useSuspenseQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { createColumnHelper } from '@tanstack/react-table'
import { accountTitle } from '@workspace/shared/accounts'
import { proxySourceLabels, type ProxyDto } from '@workspace/shared/proxies'
import { Alert, AlertDescription, AlertTitle } from '@workspace/ui/components/alert'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@workspace/ui/components/alert-dialog'
import { Badge } from '@workspace/ui/components/badge'
import { Button } from '@workspace/ui/components/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@workspace/ui/components/dropdown-menu'
import { Field, FieldLabel } from '@workspace/ui/components/field'
import { Input } from '@workspace/ui/components/input'
import { toast } from '@workspace/ui/components/toast'
import { ToggleGroup, ToggleGroupItem } from '@workspace/ui/components/toggle-group'
import { Tooltip, TooltipContent, TooltipTrigger } from '@workspace/ui/components/tooltip'
import { MoreHorizontalIcon, RefreshCwIcon } from 'lucide-react'
import { DataTable, type ClientTableFeatures } from '@/components/data-table'
import { PageHeader } from '@/components/page-header'
import { AddProxyDialog } from '@/components/proxies/add-proxy-dialog'
import { ImportProxiesDialog } from '@/components/proxies/import-proxies-dialog'
import { ProxyStatusBadge } from '@/components/proxies/proxy-status-badge'
import { api, ApiError } from '@/lib/api'
import { formatDate, formatDateTime, formatRelative } from '@/lib/format'
import { PROXY_STATUS_FILTERS, proxiesQueryOptions, proxySyncStatusQueryOptions, type ProxyStatusFilter } from '@/lib/proxies'
import { titleHead } from '@/lib/title'

export const Route = createFileRoute('/_authed/proxies')({
  head: titleHead('Прокси'),
  loader: ({ context }) =>
    Promise.all([
      context.queryClient.query({ ...proxiesQueryOptions, staleTime: 'static' }),
      context.queryClient.query({ ...proxySyncStatusQueryOptions, staleTime: 'static' }),
    ]),
  component: ProxiesPage,
})

const col = createColumnHelper<ClientTableFeatures, ProxyDto>()
type SourceFilter = 'all' | ProxyDto['source']

function matches(p: ProxyDto, query: string): boolean {
  if (!query) return true
  const q = query.toLowerCase()
  return [p.host, `${p.host}:${p.port}`, p.username, p.tag, p.account && accountTitle(p.account)].some((v) => v?.toLowerCase().includes(q))
}

function ProxiesPage() {
  const queryClient = useQueryClient()
  const { data } = useSuspenseQuery(proxiesQueryOptions)
  const { data: sync } = useSuspenseQuery(proxySyncStatusQueryOptions)
  const [statusFilter, setStatusFilter] = React.useState<ProxyStatusFilter>('all')
  const [sourceFilter, setSourceFilter] = React.useState<SourceFilter>('all')
  const [query, setQuery] = React.useState('')
  const [deleteTarget, setDeleteTarget] = React.useState<ProxyDto | null>(null)

  const refresh = () => queryClient.invalidateQueries({ queryKey: proxiesQueryOptions.queryKey })
  const failed = (title: string) => (err: unknown) => toast.add({ title, description: err instanceof ApiError ? err.message : String(err) })

  const check = useMutation({
    mutationFn: (p: ProxyDto) => api(`/proxies/${p.id}/check`, { method: 'POST' }),
    onSuccess: (_, p) => toast.add({ title: 'Проверка запущена', description: `${p.host}:${p.port}` }),
    onError: failed('Не удалось запустить проверку'),
  })
  const toggle = useMutation({
    mutationFn: (p: ProxyDto) => api(`/proxies/${p.id}`, { method: 'PATCH', json: { disabled: p.disabledAt === null } }),
    onSuccess: refresh,
    onError: failed('Не удалось изменить прокси'),
  })
  const remove = useMutation({
    mutationFn: (p: ProxyDto) => api(`/proxies/${p.id}`, { method: 'DELETE' }),
    onSuccess: (_, p) => toast.add({ title: 'Прокси удалён', description: `${p.host}:${p.port}` }),
    onError: failed('Не удалось удалить прокси'),
    onSettled: async () => {
      setDeleteTarget(null)
      await refresh()
    },
  })
  const syncNow = useMutation({
    mutationFn: () => api('/proxies/sync', { method: 'POST' }),
    onSuccess: () => toast.add({ title: 'Синхронизация с proxy-store запущена' }),
    onError: failed('Не удалось запустить синхронизацию'),
  })

  const statuses = PROXY_STATUS_FILTERS[statusFilter] as readonly string[] | null
  const rows = data.items.filter(
    (p) => (!statuses || statuses.includes(p.status)) && (sourceFilter === 'all' || p.source === sourceFilter) && matches(p, query),
  )

  const columns = React.useMemo(
    () =>
      col.columns([
        col.accessor('status', {
          header: 'Статус',
          cell: ({ row }) => {
            const p = row.original
            const badge = <ProxyStatusBadge status={p.status} />
            return (
              <span className="flex items-center gap-1.5">
                {p.lastError ? (
                  <Tooltip>
                    <TooltipTrigger render={<span />}>{badge}</TooltipTrigger>
                    <TooltipContent>{p.lastError}</TooltipContent>
                  </Tooltip>
                ) : (
                  badge
                )}
                {p.disabledAt && <Badge variant="outline">отключён</Badge>}
              </span>
            )
          },
        }),
        col.accessor('host', {
          header: 'Адрес',
          cell: ({ row }) => (
            <span className="flex flex-col">
              <span className="font-mono text-xs">
                {row.original.type === 'socks5' ? 'socks5' : 'http'}://{row.original.host}:{row.original.port}
              </span>
              {row.original.username && <span className="text-muted-foreground text-xs">{row.original.username}</span>}
            </span>
          ),
        }),
        col.accessor('source', { header: 'Источник', cell: (info) => proxySourceLabels[info.getValue()] }),
        col.accessor('latencyMs', { header: 'Задержка', cell: (info) => (info.getValue() === null ? '—' : `${info.getValue()} мс`) }),
        col.accessor('tgCountry', {
          header: () => (
            <Tooltip>
              <TooltipTrigger render={<span className="underline decoration-dotted" />}>Страна</TooltipTrigger>
              <TooltipContent>Страна выходного IP глазами Telegram</TooltipContent>
            </Tooltip>
          ),
          cell: (info) => info.getValue() ?? '—',
        }),
        col.accessor('expiresAt', { header: 'Оплачен до', cell: (info) => formatDate(info.getValue()) }),
        col.accessor('account', { header: 'Аккаунт', cell: (info) => (info.getValue() ? accountTitle(info.getValue()!) : <span className="text-muted-foreground">свободен</span>) }),
        col.accessor('tag', { header: 'Метка', cell: (info) => info.getValue() ?? '—' }),
        col.accessor('lastCheckAt', {
          header: 'Проверен',
          cell: (info) => (
            <span title={formatDateTime(info.getValue())} className="text-muted-foreground text-sm">
              {formatRelative(info.getValue())}
            </span>
          ),
        }),
        col.display({
          id: 'actions',
          header: () => <span className="sr-only">Действия</span>,
          cell: ({ row }) => {
            const p = row.original
            const label = `${p.host}:${p.port}`
            return (
              <DropdownMenu>
                <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label={`Действия: ${label}`} />}>
                  <MoreHorizontalIcon />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuGroup>
                    <DropdownMenuItem disabled={p.status === 'provisioning' || p.status === 'expired'} onClick={() => check.mutate(p)}>
                      Проверить сейчас
                    </DropdownMenuItem>
                    <DropdownMenuItem disabled={p.disabledAt === null && p.account !== null} onClick={() => toggle.mutate(p)}>
                      {p.disabledAt ? 'Включить' : 'Отключить'}
                    </DropdownMenuItem>
                    {p.source === 'manual' && (
                      <DropdownMenuItem variant="destructive" disabled={p.account !== null} onClick={() => setDeleteTarget(p)}>
                        Удалить
                      </DropdownMenuItem>
                    )}
                  </DropdownMenuGroup>
                </DropdownMenuContent>
              </DropdownMenu>
            )
          },
        }),
      ]),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mutations are stable enough; columns only render handlers
    [],
  )

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Прокси"
        description="Пул прокси для аккаунтов. Проверяются подключением к Telegram, из proxy-store — синхронизируются автоматически."
        actions={
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" disabled={syncNow.isPending} onClick={() => syncNow.mutate()}>
              <RefreshCwIcon data-icon="inline-start" />
              Синхронизировать
            </Button>
            <ImportProxiesDialog />
            <AddProxyDialog />
          </div>
        }
      />
      {sync.status && !sync.status.ok && (
        <Alert variant="destructive">
          <AlertTitle>Синхронизация с proxy-store не удалась {formatRelative(sync.status.at)}</AlertTitle>
          <AlertDescription>{sync.status.error}</AlertDescription>
        </Alert>
      )}
      {sync.status?.ok && (
        <p className="text-muted-foreground text-sm">
          proxy-store: синхронизировано {formatRelative(sync.status.at)} — новых {sync.status.created}, обновлено {sync.status.updated}, истекло {sync.status.expired}.
        </p>
      )}
      <div className="flex flex-wrap items-end gap-4">
        <Field className="w-auto">
          <FieldLabel>Статус</FieldLabel>
          <ToggleGroup variant="outline" value={[statusFilter]} onValueChange={(v) => v[0] && setStatusFilter(v[0] as ProxyStatusFilter)}>
            <ToggleGroupItem value="all">Все</ToggleGroupItem>
            <ToggleGroupItem value="ok">Работают</ToggleGroupItem>
            <ToggleGroupItem value="problems">Проблемы</ToggleGroupItem>
            <ToggleGroupItem value="other">Остальные</ToggleGroupItem>
          </ToggleGroup>
        </Field>
        <Field className="w-auto">
          <FieldLabel>Источник</FieldLabel>
          <ToggleGroup variant="outline" value={[sourceFilter]} onValueChange={(v) => v[0] && setSourceFilter(v[0] as SourceFilter)}>
            <ToggleGroupItem value="all">Все</ToggleGroupItem>
            <ToggleGroupItem value="manual">Вручную</ToggleGroupItem>
            <ToggleGroupItem value="proxy_store">proxy-store</ToggleGroupItem>
          </ToggleGroup>
        </Field>
        <Field className="w-64">
          <FieldLabel htmlFor="proxy-search">Поиск</FieldLabel>
          <Input id="proxy-search" placeholder="адрес, логин, метка, аккаунт" value={query} onChange={(e) => setQuery(e.target.value)} />
        </Field>
      </div>
      <DataTable columns={columns} data={rows} pageSize={50} empty={data.items.length ? 'Ничего не найдено' : 'Прокси ещё нет — добавьте вручную или импортируйте список'} />
      <AlertDialog open={deleteTarget !== null} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Удалить {deleteTarget?.host}:{deleteTarget?.port}?
            </AlertDialogTitle>
            <AlertDialogDescription>Прокси исчезнет из пула. Вернуть его можно, только добавив заново.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Отмена</AlertDialogCancel>
            <AlertDialogAction variant="destructive" disabled={remove.isPending} onClick={() => deleteTarget && remove.mutate(deleteTarget)}>
              Удалить
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
```

- [ ] **Шаг 4: Проверки**

```bash
fnm exec --using=26 pnpm typecheck
fnm exec --using=26 pnpm lint
fnm exec --using=26 npx vitest run --project web
# всё зелёное
```

- [ ] **Шаг 5: Коммит**

```bash
git add -A
git commit -F - <<'MSG'
feat(web): proxies page — live table with status, latency, Telegram-seen country, expiry and bound account; add, import with preview, sync, check, disable, delete
MSG
```

---

### Task 9: Хранилище mtcute с зашифрованными ключами

Провайдер хранилища на аккаунт: `driver`, `kv`, `peers`, `refMessages` — от `@mtcute/postgres` (схема `mtcute`, изоляция по `account` = id аккаунта), `authKeys` — свой `EncryptedAuthKeys` поверх `account_auth`: ключ шифруется `APP_ENCRYPTION_KEY`, открытым текстом в БД не появляется. Временные PFS-ключи не сохраняются. `prepareMtcuteStorage` выполняет миграции mtcute один раз при старте воркера; `deleteAccountStorage` удаляет всё, что mtcute хранит по аккаунту.

**Files:**
- Modify: `apps/worker/package.json`
- Modify: `apps/worker/src/main.ts`
- Create: `apps/worker/src/telegram/storage.ts`
- Test: `apps/worker/test/storage.test.ts`
- Generated: `pnpm-lock.yaml` — не писать руками (команды ниже)

**Interfaces:**
- Consumes: `accountAuth` (задача 1); `cipher`; `WorkerDeps` (задача 4).
- Produces:
  - `apps/worker/src/telegram/storage.ts`: `MTCUTE_SCHEMA`; `class EncryptedAuthKeys`; `createAccountStorage(pool: pg.Pool, db: Db, cipher: Cipher, accountId: string): ITelegramStorageProvider`; `prepareMtcuteStorage(pool: pg.Pool, db: Db, cipher: Cipher): Promise<void>`; `deleteAccountStorage(pool: pg.Pool, accountId: string): Promise<void>`

- [ ] **Шаг 1: Зависимости**

```bash
fnm exec --using=26 pnpm --filter worker add '@mtcute/postgres@^0.32'
```

- [ ] **Шаг 2: Написать падающий тест**

`apps/worker/test/storage.test.ts` — новый файл

```ts
import { randomBytes } from 'node:crypto'
import { TelegramClient } from '@mtcute/node'
import { defaultProductionDc, readStringSession, writeStringSession } from '@mtcute/core/utils.js'
import { accountAuth, accounts, eq } from '@workspace/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createAccountStorage, deleteAccountStorage, EncryptedAuthKeys, prepareMtcuteStorage } from '../src/telegram/storage.ts'
import { setupWorker, type TestWorker } from './helpers.ts'

let w: TestWorker
beforeAll(async () => {
  w = await setupWorker()
  await prepareMtcuteStorage(w.deps.pool, w.t.db, w.deps.cipher)
})
afterAll(async () => {
  await w.close()
})

const device = { deviceModel: 'Desktop', systemVersion: 'Windows 11 x64', appVersion: '7.2.9 x64', langCode: 'ru' }
async function newAccount(tgUserId: number): Promise<string> {
  const [row] = await w.t.db.insert(accounts).values({ tgUserId, source: 'tdata', clientProfile: 'desktop', device, connectionMode: 'direct' }).returning()
  return row!.id
}

const client = (storageAccountId: string) =>
  new TelegramClient({ apiId: 2040, apiHash: 'b18441a1ff607e10a989891a5462e627', storage: createAccountStorage(w.deps.pool, w.t.db, w.deps.cipher, storageAccountId), logLevel: 0 })

describe('encrypted auth keys', () => {
  it('stores keys encrypted per account and DC', async () => {
    const accountId = await newAccount(1)
    const repo = new EncryptedAuthKeys(w.t.db, w.deps.cipher, accountId)
    const key = new Uint8Array(randomBytes(256))
    await repo.set(2, key)
    const [row] = await w.t.db.select().from(accountAuth).where(eq(accountAuth.accountId, accountId))
    expect(row!.authKeyEnc).toMatch(/^v1:/)
    expect(row!.authKeyEnc).not.toContain(Buffer.from(key).toString('base64').slice(0, 24))
    expect(await repo.get(2)).toEqual(key)
    expect(await repo.get(4)).toBeNull()
    await repo.set(4, key)
    await repo.deleteByDc(2)
    expect(await repo.get(2)).toBeNull()
    await repo.deleteAll()
    expect(await w.t.db.select().from(accountAuth).where(eq(accountAuth.accountId, accountId))).toEqual([])
  })
})

describe('account storage', () => {
  it('imports a session, keeps the key only in account_auth and survives a new client', async () => {
    const accountId = await newAccount(424242)
    const authKey = new Uint8Array(randomBytes(256))
    const session = writeStringSession({
      version: 3,
      primaryDcs: { main: defaultProductionDc.main, media: defaultProductionDc.media },
      self: { userId: 424242, isBot: false, isPremium: false, usernames: [] },
      authKey,
    })

    const first = client(accountId)
    await first.importSession(session)
    await first.destroy()

    expect((await w.t.db.select().from(accountAuth).where(eq(accountAuth.accountId, accountId))).map((r) => r.dcId)).toEqual([2])
    const raw = await w.deps.pool.query('select count(*)::int as n from mtcute.auth_keys where account = $1', [accountId])
    expect(raw.rows[0]).toEqual({ n: 0 })

    const second = client(accountId)
    try {
      const exported = readStringSession(await second.exportSession())
      expect(exported.authKey).toEqual(authKey)
      expect(exported.self?.userId).toBe(424242)
    } finally {
      await second.destroy()
    }

    await deleteAccountStorage(w.deps.pool, accountId)
    const left = await w.deps.pool.query('select count(*)::int as n from mtcute.key_value where account = $1', [accountId])
    expect(left.rows[0]).toEqual({ n: 0 })
  })
})
```

- [ ] **Шаг 3: Убедиться, что тест падает**

```bash
fnm exec --using=26 npx vitest run --project worker apps/worker/test/storage.test.ts
# FAIL: Cannot find module '../src/telegram/storage.ts'
```

- [ ] **Шаг 4: Реализация**

`apps/worker/package.json` — изменения

```diff
--- a/apps/worker/package.json
+++ b/apps/worker/package.json
@@ -12,6 +12,7 @@
   "dependencies": {
     "@mtcute/core": "^0.32.3",
     "@mtcute/node": "^0.32.3",
+    "@mtcute/postgres": "^0.32.3",
     "@workspace/db": "workspace:*",
     "@workspace/server": "workspace:*",
     "@workspace/shared": "workspace:*",
```

`apps/worker/src/main.ts` — изменения

```diff
--- a/apps/worker/src/main.ts
+++ b/apps/worker/src/main.ts
@@ -7,6 +7,7 @@ import { acquireSingletonLock } from './lock.ts'
 import { createMtcuteProxyChecker } from './proxies/checker.ts'
 import { createProxyHealth } from './proxies/health.ts'
 import { syncProxyStore } from './proxies/proxy-store.ts'
+import { prepareMtcuteStorage } from './telegram/storage.ts'
 import { createWorkerRuntime } from './runtime.ts'
 
 const env = loadEnv()
@@ -31,6 +32,9 @@ const bus = await createEventBus({ publisher: redis, subscriber, logger })
 const cipher = createCipher(env.APP_ENCRYPTION_KEY)
 const settings = await SettingsService.create({ db: database.db, cipher, bus, logger })
 
+// mtcute's own tables: migrate once before accounts load in parallel
+await prepareMtcuteStorage(database.pool, database.db, cipher)
+
 const deps: WorkerDeps = { env, db: database.db, pool: database.pool, redis, queueRedis, bus, settings, cipher, logger }
 const proxyChecker = createMtcuteProxyChecker(() => ({ apiId: settings.get('telegram.desktop.apiId'), apiHash: settings.get('telegram.desktop.apiHash') }))
 const proxyHealth = createProxyHealth(deps, proxyChecker)
```

`apps/worker/src/telegram/storage.ts` — новый файл

```ts
import type { IAuthKeysRepository, ITelegramStorageProvider } from '@mtcute/core'
import { TelegramClient } from '@mtcute/node'
import { PostgresStorage } from '@mtcute/postgres'
import { accountAuth, and, eq, type Db } from '@workspace/db'
import type { Cipher } from '@workspace/shared/crypto'
import type pg from 'pg'

/** Schema of @mtcute/postgres' own tables (peers cache, update state); drizzle never touches it. */
export const MTCUTE_SCHEMA = 'mtcute'
const MTCUTE_TABLES = ['key_value', 'auth_keys', 'temp_auth_keys', 'peers', 'message_refs'] as const

/**
 * Auth keys of one account, encrypted with APP_ENCRYPTION_KEY in `account_auth` — never in clear text
 * (@mtcute/postgres would store them raw). Temporary PFS keys are not used.
 */
export class EncryptedAuthKeys implements IAuthKeysRepository {
  readonly #db: Db
  readonly #cipher: Cipher
  readonly #accountId: string

  constructor(db: Db, cipher: Cipher, accountId: string) {
    this.#db = db
    this.#cipher = cipher
    this.#accountId = accountId
  }

  async set(dc: number, key: Uint8Array | null): Promise<void> {
    if (key === null) return this.deleteByDc(dc)
    const authKeyEnc = this.#cipher.encrypt(Buffer.from(key).toString('base64'))
    await this.#db
      .insert(accountAuth)
      .values({ accountId: this.#accountId, dcId: dc, authKeyEnc })
      .onConflictDoUpdate({ target: [accountAuth.accountId, accountAuth.dcId], set: { authKeyEnc, updatedAt: new Date() } })
  }

  async get(dc: number): Promise<Uint8Array | null> {
    const [row] = await this.#db
      .select({ authKeyEnc: accountAuth.authKeyEnc })
      .from(accountAuth)
      .where(and(eq(accountAuth.accountId, this.#accountId), eq(accountAuth.dcId, dc)))
    return row ? new Uint8Array(Buffer.from(this.#cipher.decrypt(row.authKeyEnc), 'base64')) : null
  }

  setTemp(): void {}

  getTemp(): null {
    return null
  }

  async deleteByDc(dc: number): Promise<void> {
    await this.#db.delete(accountAuth).where(and(eq(accountAuth.accountId, this.#accountId), eq(accountAuth.dcId, dc)))
  }

  async deleteAll(): Promise<void> {
    await this.#db.delete(accountAuth).where(eq(accountAuth.accountId, this.#accountId))
  }
}

/** mtcute storage of one account: everything from @mtcute/postgres except the auth keys. */
export function createAccountStorage(pool: pg.Pool, db: Db, cipher: Cipher, accountId: string): ITelegramStorageProvider {
  const pg = new PostgresStorage(pool, { schema: MTCUTE_SCHEMA, account: accountId })
  return { driver: pg.driver, kv: pg.kv, peers: pg.peers, refMessages: pg.refMessages, authKeys: new EncryptedAuthKeys(db, cipher, accountId) }
}

/**
 * Runs @mtcute/postgres migrations once at worker start, so that dozens of accounts loading at the same
 * time do not race on `create table`. No network: prepare() only loads the storage.
 */
export async function prepareMtcuteStorage(pool: pg.Pool, db: Db, cipher: Cipher): Promise<void> {
  const client = new TelegramClient({ apiId: 1, apiHash: '0', storage: createAccountStorage(pool, db, cipher, '__bootstrap__'), logLevel: 0 })
  try {
    await client.prepare()
  } finally {
    await client.destroy()
  }
}

/** Forgets everything mtcute kept for the account (auth keys go with `account_auth` rows). */
export async function deleteAccountStorage(pool: pg.Pool, accountId: string): Promise<void> {
  for (const table of MTCUTE_TABLES) {
    await pool.query(`delete from "${MTCUTE_SCHEMA}"."${table}" where account = $1`, [accountId]).catch((err: { code?: string }) => {
      // 42P01: the table does not exist (storage never prepared)
      if (err.code !== '42P01') throw err
    })
  }
}
```

- [ ] **Шаг 5: Проверки**

```bash
fnm exec --using=26 pnpm typecheck
fnm exec --using=26 pnpm lint
fnm exec --using=26 npx vitest run --project worker
# всё зелёное
```

- [ ] **Шаг 6: Коммит**

```bash
git add -A
git commit -F - <<'MSG'
feat(worker): mtcute storage in Postgres with auth keys encrypted in account_auth; one-time mtcute migrations at start
MSG
```

---

### Task 10: Импорт tdata в API

`POST /imports` (multipart) со своим лимитом тела `import.maxZipSizeMb` — глобальный лимит 1 МиБ этот путь пропускает. Архив распаковывается потоково (`fflate`) во временную папку: проверка сигнатуры zip (иначе не-zip «распаковывается» в пустоту), безопасные пути (zip-slip), лимиты числа файлов и суммарного размера. Корни tdata ищутся по `key_<name>s` на любой глубине; `Tdata.open({ ..., ignoreVersion: true })`; код-пароль — `passcode_required` / `passcode_invalid`. Сессия каждого найденного аккаунта сразу шифруется в `import_items`; папка удаляется в `finally`. Тело запроса в аудит не пишется (`payload: null`).

`POST /imports/:id/confirm` — решение на строку: `proxy` (конкретный свободный), `auto` (свободный из пула), `direct`, `skip`; дубли можно только пропустить. Аккаунт создаётся с профилем Desktop из настроек (`telegram.desktop.*` → `device`) и `session_import_enc`, затем воркеру уходит `account.sync`. Тестовые tdata генерирует `convertToTdata` со случайным ключом. Drizzle-операторы в api тоже берутся из `@workspace/db`.

**Files:**
- Modify: `packages/db/src/index.ts`
- Modify: `apps/api/package.json`
- Modify: `apps/api/src/app.ts`
- Modify: `apps/api/src/lib/sessions.ts`
- Create: `apps/api/src/lib/zip.ts`
- Modify: `apps/api/src/routes/audit.ts`
- Modify: `apps/api/src/routes/auth.ts`
- Modify: `apps/api/src/routes/health.ts`
- Create: `apps/api/src/routes/imports.ts`
- Modify: `apps/api/src/services/admins.ts`
- Create: `apps/api/src/services/imports.ts`
- Modify: `apps/api/src/services/proxies.ts`
- Test (modify): `apps/api/test/audit.test.ts`
- Test (modify): `apps/api/test/cli.test.ts`
- Test: `apps/api/test/imports.test.ts`
- Test (modify): `apps/api/test/proxies.test.ts`
- Test (modify): `apps/api/test/settings.test.ts`
- Test: `apps/api/test/tdata-fixture.ts`
- Generated: `pnpm-lock.yaml` — не писать руками (команды ниже)

**Interfaces:**
- Consumes: `import_batches`, `import_items`, `accounts` (задача 1); `confirmImportInput`, `ImportBatchDto` (задача 2); `isProxyFree`-логика (здесь, затем задача 14).
- Produces:
  - `apps/api/src/lib/zip.ts`: `interface ZipLimits`; `class ZipLimitError`; `safeEntryPath(name: string): string | null`; `extractZip(data: Uint8Array, dir: string, limits: ZipLimits): number`
  - `apps/api/src/routes/imports.ts`: `importRoutes`
  - `apps/api/src/services/imports.ts`: `interface TdataRoot`; `findTdataRoots(base: string): Promise<TdataRoot[]>`; `interface ImportDeps`; `createImport(`; `getImport(db: Db, id: string): Promise<ImportBatchDto>`; `confirmImport(`

- [ ] **Шаг 1: Зависимости**

```bash
fnm exec --using=26 pnpm --filter api add '@mtcute/convert@^0.32' '@mtcute/core@^0.32' 'fflate@^0.8'
fnm exec --using=26 pnpm --filter api remove drizzle-orm
```

- [ ] **Шаг 2: Написать падающий тест**

`apps/api/test/audit.test.ts` — изменения

```diff
--- a/apps/api/test/audit.test.ts
+++ b/apps/api/test/audit.test.ts
@@ -1,5 +1,5 @@
 import { auditLog } from '@workspace/db'
-import { desc, eq } from 'drizzle-orm'
+import { desc, eq } from '@workspace/db'
 import { Hono } from 'hono'
 import { afterAll, beforeAll, describe, expect, it } from 'vitest'
 import type { AppDeps, AppEnv, SessionAdmin } from '../src/deps.ts'
```

`apps/api/test/cli.test.ts` — изменения

```diff
--- a/apps/api/test/cli.test.ts
+++ b/apps/api/test/cli.test.ts
@@ -4,7 +4,7 @@ import { fileURLToPath } from 'node:url'
 import { promisify } from 'node:util'
 import { admins, auditLog } from '@workspace/db'
 import { createTestDatabase, type TestDatabase } from '@workspace/db/testing'
-import { eq } from 'drizzle-orm'
+import { eq } from '@workspace/db'
 import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'
 
 const run = promisify(execFile)
```

`apps/api/test/imports.test.ts` — новый файл

```ts
import { zipSync } from 'fflate'
import { accounts, auditLog, desc, eq, importBatches, importItems, proxies } from '@workspace/db'
import type { ImportBatchDto } from '@workspace/shared/accounts'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { loginAs, send, setupApp, type TestApp } from './helpers.ts'
import { makeTdataZip } from './tdata-fixture.ts'

let ta: TestApp
let cookie: string
beforeAll(async () => {
  ta = await setupApp()
  cookie = (await loginAs(ta)).cookie
})
afterAll(async () => {
  await ta.close()
})
beforeEach(async () => {
  await ta.t.db.delete(importBatches)
  await ta.t.db.delete(accounts)
  await ta.t.db.delete(proxies)
  ta.commands.sent = []
})

function upload(zip: Uint8Array, passcode?: string, name = 'tdata.zip') {
  const form = new FormData()
  form.set('file', new File([new Uint8Array(zip)], name, { type: 'application/zip' }))
  if (passcode !== undefined) form.set('passcode', passcode)
  return send(ta.app, '/api/imports', { cookie, body: form })
}

const device = { deviceModel: 'Desktop', systemVersion: 'Windows 11 x64', appVersion: '7.2.9 x64', langCode: 'ru' }

describe('tdata upload', () => {
  it('finds every account of a nested tdata and keeps the sessions encrypted', async () => {
    const res = await upload(await makeTdataZip({ users: [5001, 5002], folder: 'Telegram Portable' }))
    expect(res.status).toBe(201)
    const batch = (await res.json()) as ImportBatchDto
    expect(batch).toMatchObject({ filename: 'tdata.zip', status: 'ready' })
    expect(batch.items.map((i) => [i.pathInArchive, i.accountIndex, i.tgUserId, i.dcId, i.duplicateOf])).toEqual([
      ['Telegram Portable/tdata', 0, 5001, 2, null],
      ['Telegram Portable/tdata', 1, 5002, 2, null],
    ])
    const rows = await ta.t.db.select().from(importItems)
    expect(rows.every((r) => r.sessionEnc.startsWith('v1:'))).toBe(true)
    const [audit] = await ta.t.db.select().from(auditLog).where(eq(auditLog.action, 'account.import.upload')).orderBy(desc(auditLog.id)).limit(1)
    expect(audit!.payload).toEqual({ filename: 'tdata.zip', accounts: 2 })
  })

  it('asks for the local passcode and rejects a wrong one', async () => {
    const zip = await makeTdataZip({ users: [6001], passcode: 'local-pass' })
    expect(await (await upload(zip)).json()).toMatchObject({ error: 'passcode_required' })
    expect(await (await upload(zip, 'nope')).json()).toMatchObject({ error: 'passcode_invalid' })
    const ok = await upload(zip, 'local-pass')
    expect(ok.status).toBe(201)
    const [audit] = await ta.t.db.select().from(auditLog).where(eq(auditLog.action, 'account.import.upload')).orderBy(desc(auditLog.id)).limit(1)
    expect(JSON.stringify(audit!.payload)).not.toContain('local-pass')
  })

  it.each([
    ['no tdata inside', zipSync({ 'readme.txt': new Uint8Array([1]) }), 'tdata_not_found'],
    ['not a zip', new Uint8Array([1, 2, 3, 4]), 'zip_invalid'],
    ['a path escaping the folder', zipSync({ '../evil/key_datas': new Uint8Array([1]) }), 'zip_path'],
  ])('rejects %s', async (_, zip, error) => {
    const res = await upload(zip)
    expect(res.status).toBe(422)
    expect(await res.json()).toMatchObject({ error })
  })

  it('enforces the archive limits from settings', async () => {
    await ta.deps.settings.update({ 'import.maxFiles': 2 }, { adminId: null })
    try {
      expect(await (await upload(await makeTdataZip({ users: [7001] }))).json()).toMatchObject({ error: 'zip_files' })
    } finally {
      await ta.deps.settings.update({ 'import.maxFiles': null }, { adminId: null })
    }
    await ta.deps.settings.update({ 'import.maxZipSizeMb': 1 }, { adminId: null })
    try {
      // bigger than the 1 MB route limit; the global 1 MiB cap does not apply here, the route's does
      const tooBig = await upload(zipSync({ 'big.bin': new Uint8Array(1_200_000).map(() => Math.floor(Math.random() * 256)) }, { level: 0 }))
      expect(tooBig.status).toBe(413)
    } finally {
      await ta.deps.settings.update({ 'import.maxZipSizeMb': null }, { adminId: null })
    }
  })
})

describe('confirming an import', () => {
  async function prepared(users: number[]) {
    return (await (await upload(await makeTdataZip({ users }))).json()) as ImportBatchDto
  }
  // a counter, not Math.random: the tests share one database and proxy endpoints are unique
  let nextHost = 0
  const proxy = async (values: Partial<typeof proxies.$inferInsert> = {}) =>
    (await ta.t.db.insert(proxies).values({ source: 'manual', type: 'socks5', host: `10.3.3.${++nextHost}`, port: 1080, status: 'ok', latencyMs: 100, ...values }).returning())[0]!

  it('creates accounts with the chosen proxy, an automatic one or none, and starts them', async () => {
    const batch = await prepared([8001, 8002, 8003, 8004])
    const chosen = await proxy({ latencyMs: 300 })
    const auto = await proxy({ latencyMs: 50 })
    await proxy({ status: 'dead' })
    const [i1, i2, i3, i4] = batch.items
    const res = await send(ta.app, `/api/imports/${batch.id}/confirm`, {
      cookie,
      body: {
        items: [
          { id: i1!.id, decision: 'proxy', proxyId: chosen.id },
          { id: i2!.id, decision: 'auto' },
          { id: i3!.id, decision: 'direct' },
          { id: i4!.id, decision: 'skip' },
        ],
      },
    })
    expect(await res.json()).toEqual({ created: 3, skipped: 1 })
    const rows = await ta.t.db.select().from(accounts)
    const byUser = Object.fromEntries(rows.map((r) => [r.tgUserId, r]))
    expect(byUser[8001]).toMatchObject({ proxyId: chosen.id, connectionMode: 'proxy', status: 'pending_check', source: 'tdata', clientProfile: 'desktop', device })
    expect(byUser[8002]).toMatchObject({ proxyId: auto.id, connectionMode: 'proxy' })
    expect(byUser[8003]).toMatchObject({ proxyId: null, connectionMode: 'direct' })
    expect(byUser[8004]).toBeUndefined()
    expect(rows.every((r) => r.sessionImportEnc?.startsWith('v1:'))).toBe(true)
    expect(ta.commands.sent.map((c) => c.type)).toEqual(['account.sync', 'account.sync', 'account.sync'])

    const again = await send(ta.app, `/api/imports/${batch.id}/confirm`, { cookie, body: { items: [{ id: i4!.id, decision: 'skip' }] } })
    expect(await again.json()).toMatchObject({ error: 'already_confirmed' })
  })

  it('refuses duplicates, busy or broken proxies and an empty pool for "auto"', async () => {
    const first = await prepared([9001])
    await send(ta.app, `/api/imports/${first.id}/confirm`, { cookie, body: { items: [{ id: first.items[0]!.id, decision: 'direct' }] } })

    const batch = await prepared([9001, 9002])
    const [dup, fresh] = batch.items
    expect(dup!.duplicateOf).not.toBeNull()
    const refuse = async (items: unknown[], error: string) => {
      const res = await send(ta.app, `/api/imports/${batch.id}/confirm`, { cookie, body: { items } })
      expect(res.status).toBe(409)
      expect(await res.json()).toMatchObject({ error })
    }
    await refuse([{ id: dup!.id, decision: 'direct' }], 'duplicate')
    const dead = await proxy({ status: 'dead' })
    await refuse([{ id: fresh!.id, decision: 'proxy', proxyId: dead.id }], 'proxy_unavailable')
    await refuse([{ id: fresh!.id, decision: 'auto' }], 'no_free_proxy')
    // nothing was half-done
    expect((await ta.t.db.select().from(accounts)).map((a) => a.tgUserId)).toEqual([9001])
  })
})
```

`apps/api/test/proxies.test.ts` — изменения

```diff
--- a/apps/api/test/proxies.test.ts
+++ b/apps/api/test/proxies.test.ts
@@ -1,6 +1,6 @@
 import { accounts, auditLog, proxies } from '@workspace/db'
 import type { ProxyDto } from '@workspace/shared/proxies'
-import { desc, eq } from 'drizzle-orm'
+import { desc, eq } from '@workspace/db'
 import { afterAll, beforeAll, describe, expect, it } from 'vitest'
 import { loginAs, send, setupApp, type TestApp } from './helpers.ts'
```

`apps/api/test/settings.test.ts` — изменения

```diff
--- a/apps/api/test/settings.test.ts
+++ b/apps/api/test/settings.test.ts
@@ -1,6 +1,6 @@
 import { auditLog } from '@workspace/db'
 import type { AppEvent } from '@workspace/shared/events'
-import { desc, eq } from 'drizzle-orm'
+import { desc, eq } from '@workspace/db'
 import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
 import { loginAs, send, setupApp, type TestApp } from './helpers.ts'
```

`apps/api/test/tdata-fixture.ts` — новый файл

```ts
import { randomBytes } from 'node:crypto'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { convertToTdata } from '@mtcute/convert'
import { defaultProductionDc } from '@mtcute/core/utils.js'
import { zipSync } from 'fflate'

/**
 * A real TDesktop tdata (written by mtcute) for made-up accounts with random auth keys, zipped under
 * `folder/tdata/…` — no real session is ever used in tests.
 */
export async function makeTdataZip(opts: { users: number[]; passcode?: string; folder?: string; extra?: Record<string, Uint8Array> }): Promise<Uint8Array> {
  const dir = await mkdtemp(join(tmpdir(), 'accs-fixture-'))
  try {
    const tdataDir = join(dir, 'tdata')
    const sessions = opts.users.map((userId) => ({
      version: 3,
      primaryDcs: defaultProductionDc,
      self: { userId, isBot: false, isPremium: false, usernames: [] },
      authKey: new Uint8Array(randomBytes(256)),
    }))
    await convertToTdata(sessions, { path: tdataDir, ...(opts.passcode ? { passcode: opts.passcode } : {}) })
    const files: Record<string, Uint8Array> = { ...opts.extra }
    for (const entry of await readdir(tdataDir, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile()) continue
      const path = join(entry.parentPath, entry.name)
      files[`${opts.folder ? `${opts.folder}/` : ''}tdata/${relative(tdataDir, path)}`] = new Uint8Array(await readFile(path))
    }
    return zipSync(files)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}
```

- [ ] **Шаг 3: Убедиться, что тест падает**

```bash
fnm exec --using=26 npx vitest run --project api apps/api/test/imports.test.ts
# FAIL: Cannot find module '../src/services/imports.ts'
```

- [ ] **Шаг 4: Реализация**

`packages/db/src/index.ts` — изменения

```diff
--- a/packages/db/src/index.ts
+++ b/packages/db/src/index.ts
@@ -17,4 +17,4 @@ export {
 
 // one drizzle-orm instance for every workspace package: apps import the operators from here, not from drizzle-orm
 // (a second copy — e.g. a peer variant pulled by @mtcute/node's optional sqlite — makes their SQL types incompatible)
-export { and, asc, count, desc, eq, getTableColumns, gt, gte, inArray, isNotNull, isNull, lt, lte, ne, not, notInArray, or, sql } from 'drizzle-orm'
+export { and, asc, count, desc, eq, getTableColumns, gt, gte, inArray, isNotNull, isNull, lt, lte, ne, not, notInArray, or, sql, type SQL } from 'drizzle-orm'
```

`apps/api/package.json` — изменения

```diff
--- a/apps/api/package.json
+++ b/apps/api/package.json
@@ -14,10 +14,12 @@
     "@hono/node-server": "^2.1.3",
     "@hono/zod-validator": "^0.9.1",
     "@inquirer/password": "^5.2.2",
+    "@mtcute/convert": "^0.32.3",
+    "@mtcute/core": "^0.32.3",
     "@workspace/db": "workspace:*",
     "@workspace/server": "workspace:*",
     "@workspace/shared": "workspace:*",
-    "drizzle-orm": "^0.45.3",
+    "fflate": "^0.8.3",
     "hono": "^4.13.12",
     "ioredis": "^6.0.0",
     "zod": "^4.6.5"
```

`apps/api/src/app.ts` — изменения

```diff
--- a/apps/api/src/app.ts
+++ b/apps/api/src/app.ts
@@ -15,12 +15,13 @@ import { auditRoutes } from './routes/audit.ts'
 import { authRoutes } from './routes/auth.ts'
 import { eventRoutes } from './routes/events.ts'
 import { healthRoutes } from './routes/health.ts'
+import { importRoutes } from './routes/imports.ts'
 import { proxyRoutes } from './routes/proxies.ts'
 import { settingsRoutes } from './routes/settings.ts'
 import { WorkerTimeoutError } from '@workspace/server'
 import { AdminError } from './services/admins.ts'
 
-/** Global cap on request bodies; plan-3 upload routes must be excluded and get their own route-level limit (import.maxZipSizeMb). */
+/** Global cap on request bodies; the tdata upload is excluded and limited by import.maxZipSizeMb instead. */
 const MAX_BODY_BYTES = 1024 * 1024
 
 const ADMIN_ERRORS = {
@@ -49,9 +50,11 @@ export function createApp(deps: AppDeps): Hono<AppEnv> {
   const api = new Hono<AppEnv>()
   // first: nothing below (origin check, session lookup, audit, validators) may buffer an oversized body;
   // enforced for chunked bodies too, and a 413 short-circuits before the audit trail
+  const globalBodyLimit = bodyLimit({ maxSize: MAX_BODY_BYTES, onError: (c) => c.json({ error: 'payload_too_large', message: 'Слишком большой запрос' }, 413) })
   api.use(
     '*',
-    bodyLimit({ maxSize: MAX_BODY_BYTES, onError: (c) => c.json({ error: 'payload_too_large', message: 'Слишком большой запрос' }, 413) }),
+    // the tdata upload has its own, larger limit (routes/imports.ts)
+    (c, next) => (c.req.method === 'POST' && c.req.path === '/api/imports' ? next() : globalBodyLimit(c, next)),
     originGuard,
     sessionLoader,
     auditTrail,
@@ -62,6 +65,7 @@ export function createApp(deps: AppDeps): Hono<AppEnv> {
   api.route('/', adminRoutes)
   api.route('/', settingsRoutes)
   api.route('/', proxyRoutes)
+  api.route('/', importRoutes)
   api.route('/', auditRoutes)
   api.route('/', eventRoutes)
   api.all('*', (c) => c.json({ error: 'not_found' }, 404))
```

`apps/api/src/lib/sessions.ts` — изменения

```diff
--- a/apps/api/src/lib/sessions.ts
+++ b/apps/api/src/lib/sessions.ts
@@ -1,6 +1,6 @@
 import { createHash, randomBytes } from 'node:crypto'
 import { admins, adminSessions, type Db } from '@workspace/db'
-import { and, eq, gt, isNull, type SQL } from 'drizzle-orm'
+import { and, eq, gt, isNull, type SQL } from '@workspace/db'
 import type { SessionAdmin } from '../deps.ts'
 
 export const SESSION_COOKIE = 'accs_session'
```

`apps/api/src/lib/zip.ts` — новый файл

```ts
import { closeSync, mkdirSync, openSync, writeSync } from 'node:fs'
import { dirname, join, sep } from 'node:path'
import { Unzip, UnzipInflate } from 'fflate'

export interface ZipLimits {
  maxFiles: number
  maxUnpackedBytes: number
}

export class ZipLimitError extends Error {
  readonly kind: 'files' | 'size' | 'path'
  constructor(kind: ZipLimitError['kind'], message: string) {
    super(message)
    this.name = 'ZipLimitError'
    this.kind = kind
  }
}

/** A safe relative path inside the target dir, or null for entries we skip (directories, macOS metadata). */
export function safeEntryPath(name: string): string | null {
  const normalized = name.replaceAll('\\', '/')
  if (normalized.endsWith('/')) return null
  const parts = normalized.split('/').filter((p) => p !== '' && p !== '.')
  if (parts[0] === '__MACOSX' || parts.at(-1) === '.DS_Store') return null
  if (normalized.startsWith('/') || /^[a-z]:/i.test(normalized) || parts.includes('..') || parts.length === 0) {
    throw new ZipLimitError('path', `Недопустимый путь в архиве: ${name}`)
  }
  return parts.join(sep)
}

/**
 * Streams a zip into `dir`: entries are written one by one (never the whole archive unpacked in memory),
 * the file count and the unpacked size are capped as they grow (zip bombs), paths cannot escape `dir`
 * (zip-slip), and nothing but regular files is ever created — a symlink entry becomes a small text file.
 */
export function extractZip(data: Uint8Array, dir: string, limits: ZipLimits): number {
  // the streaming reader silently finds nothing in non-zip bytes: check the local-file / empty-archive signature
  const signature = data.length >= 4 ? (data[0]! | (data[1]! << 8) | (data[2]! << 16) | (data[3]! << 24)) >>> 0 : 0
  if (signature !== 0x04034b50 && signature !== 0x06054b50) throw new Error('not a zip archive')
  let files = 0
  let total = 0
  let failure: Error | null = null
  const unzip = new Unzip()
  unzip.register(UnzipInflate)
  unzip.onfile = (file) => {
    if (failure) return
    let relative: string | null
    try {
      relative = safeEntryPath(file.name)
    } catch (err) {
      failure = err as Error
      return
    }
    if (relative === null) return
    if (++files > limits.maxFiles) {
      failure = new ZipLimitError('files', `В архиве больше ${limits.maxFiles} файлов`)
      return
    }
    const target = join(dir, relative)
    mkdirSync(dirname(target), { recursive: true })
    const fd = openSync(target, 'wx')
    file.ondata = (err, chunk, final) => {
      if (failure) return
      if (err) {
        failure = err
      } else {
        total += chunk.length
        if (total > limits.maxUnpackedBytes) failure = new ZipLimitError('size', `После распаковки архив больше ${Math.round(limits.maxUnpackedBytes / 1024 / 1024)} МБ`)
        else writeSync(fd, chunk)
      }
      if (final || failure) closeSync(fd)
    }
    file.start()
  }
  // feed in slices so a limit stops the inflation early instead of after the whole archive
  const STEP = 64 * 1024
  for (let offset = 0; offset < data.length && !failure; offset += STEP) {
    unzip.push(data.subarray(offset, offset + STEP), offset + STEP >= data.length)
  }
  if (failure) throw failure
  return files
}
```

`apps/api/src/routes/audit.ts` — изменения

```diff
--- a/apps/api/src/routes/audit.ts
+++ b/apps/api/src/routes/audit.ts
@@ -1,7 +1,7 @@
 import { zValidator } from '@hono/zod-validator'
 import { admins, auditLog } from '@workspace/db'
 import { auditQuery, type AuditPage } from '@workspace/shared/api'
-import { and, count, desc, eq, gte, lte, type SQL } from 'drizzle-orm'
+import { and, count, desc, eq, gte, lte, type SQL } from '@workspace/db'
 import { Hono } from 'hono'
 import type { AppEnv } from '../deps.ts'
 import { validationHook } from './validation.ts'
```

`apps/api/src/routes/auth.ts` — изменения

```diff
--- a/apps/api/src/routes/auth.ts
+++ b/apps/api/src/routes/auth.ts
@@ -3,7 +3,7 @@ import { zValidator } from '@hono/zod-validator'
 import { admins } from '@workspace/db'
 import { changePasswordInput, loginInput, type MeResponse } from '@workspace/shared/api'
 import { parseDuration } from '@workspace/shared/duration'
-import { eq } from 'drizzle-orm'
+import { eq } from '@workspace/db'
 import { Hono } from 'hono'
 import { deleteCookie, setCookie } from 'hono/cookie'
 import type { AppEnv } from '../deps.ts'
```

`apps/api/src/routes/health.ts` — изменения

```diff
--- a/apps/api/src/routes/health.ts
+++ b/apps/api/src/routes/health.ts
@@ -1,4 +1,4 @@
-import { sql } from 'drizzle-orm'
+import { sql } from '@workspace/db'
 import { readWorkerHeartbeat } from '@workspace/server'
 import { Hono } from 'hono'
 import type { AppEnv } from '../deps.ts'
```

`apps/api/src/routes/imports.ts` — новый файл

```ts
import { zValidator } from '@hono/zod-validator'
import { confirmImportInput } from '@workspace/shared/accounts'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { createMiddleware } from 'hono/factory'
import { z } from 'zod'
import type { AppEnv } from '../deps.ts'
import { DomainError } from '../lib/errors.ts'
import { audited } from '../middleware/audit.ts'
import { confirmImport, createImport, getImport } from '../services/imports.ts'
import { validationHook } from './validation.ts'

const idParam = z.object({ id: z.uuid() })
const MB = 1024 * 1024
/** room for the multipart framing and the passcode field around the zip */
const MULTIPART_OVERHEAD = 64 * 1024

/** The global 1 MiB cap skips this route; here the limit follows import.maxZipSizeMb. */
const uploadLimit = createMiddleware<AppEnv>(async (c, next) =>
  bodyLimit({
    maxSize: c.get('deps').settings.get('import.maxZipSizeMb') * MB + MULTIPART_OVERHEAD,
    onError: (ctx) => ctx.json({ error: 'payload_too_large', message: `Архив больше ${ctx.get('deps').settings.get('import.maxZipSizeMb')} МБ` }, 413),
  })(c, next),
)

export const importRoutes = new Hono<AppEnv>()
  // audited first: payload null means the archive and the passcode never reach the audit log, even on a 413
  .post('/imports', audited('account.import.upload', { payload: null }), uploadLimit, async (c) => {
    const form = await c.req.parseBody()
    const file = form.file
    if (!(file instanceof File)) throw new DomainError(400, 'validation', 'Приложите zip-архив с tdata')
    const passcode = typeof form.passcode === 'string' && form.passcode !== '' ? form.passcode : undefined
    const batch = await createImport(c.get('deps'), {
      filename: file.name,
      data: new Uint8Array(await file.arrayBuffer()),
      ...(passcode ? { passcode } : {}),
      adminId: c.get('admin')?.id ?? null,
    })
    c.set('audit', { ...c.get('audit'), targetType: 'import', targetId: batch.id, payload: { filename: batch.filename, accounts: batch.items.length } })
    return c.json(batch, 201)
  })
  .get('/imports/:id', zValidator('param', idParam, validationHook), async (c) => c.json(await getImport(c.get('deps').db, c.req.valid('param').id)))
  .post(
    '/imports/:id/confirm',
    audited('account.import.confirm', { target: ['import', 'id'] }),
    zValidator('param', idParam, validationHook),
    zValidator('json', confirmImportInput, validationHook),
    async (c) => {
      const deps = c.get('deps')
      const { accountIds, ...result } = await confirmImport(deps, c.req.valid('param').id, c.req.valid('json'))
      for (const accountId of accountIds) await deps.commands.send({ type: 'account.sync', accountId })
      if (accountIds.length > 0) await deps.bus.publish({ type: 'accounts.changed', ids: accountIds })
      return c.json(result)
    },
  )
```

`apps/api/src/services/admins.ts` — изменения

```diff
--- a/apps/api/src/services/admins.ts
+++ b/apps/api/src/services/admins.ts
@@ -1,6 +1,6 @@
 import { admins, type Db } from '@workspace/db'
 import type { AdminDto } from '@workspace/shared/api'
-import { and, asc, count, eq, isNull, ne, sql } from 'drizzle-orm'
+import { and, asc, count, eq, isNull, ne, sql } from '@workspace/db'
 import { hashPassword } from '../lib/password.ts'
 import { deleteAdminSessions } from '../lib/sessions.ts'
```

`apps/api/src/services/imports.ts` — новый файл

```ts
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { writeStringSession } from '@mtcute/core/utils.js'
import { convertFromTdata, Tdata } from '@mtcute/convert'
import { accounts, importBatches, importItems, proxies, type Db } from '@workspace/db'
import type { SettingsService } from '@workspace/server'
import type { ConfirmImportInput, ImportBatchDto } from '@workspace/shared/accounts'
import type { Cipher } from '@workspace/shared/crypto'
import { parseDuration } from '@workspace/shared/duration'
import { and, eq, inArray, isNull, notInArray } from '@workspace/db'
import { DomainError } from '../lib/errors.ts'
import { extractZip, ZipLimitError } from '../lib/zip.ts'

const MB = 1024 * 1024
/** TDesktop's key file: `key_` + data name + `s` (`key_datas` unless started with -key). */
const KEY_FILE_RE = /^key_([a-z0-9_]+)s$/i

export interface TdataRoot {
  dir: string
  dataKey: string
}

/** Every directory holding a key file is a tdata root; the archive may contain several, at any depth. */
export async function findTdataRoots(base: string): Promise<TdataRoot[]> {
  const roots: TdataRoot[] = []
  const entries = await readdir(base, { recursive: true, withFileTypes: true })
  for (const entry of entries) {
    const match = entry.isFile() ? KEY_FILE_RE.exec(entry.name) : null
    if (match) roots.push({ dir: entry.parentPath, dataKey: match[1]! })
  }
  return roots.sort((a, b) => a.dir.localeCompare(b.dir))
}

interface FoundAccount {
  pathInArchive: string
  accountIndex: number
  tgUserId: number
  dcId: number
  session: string
}

const isDecryptError = (err: unknown) => /decrypt|passcode|key|aes|padding|checksum|hash/i.test(err instanceof Error ? err.message : String(err))

async function readAccounts(base: string, roots: TdataRoot[], passcode: string | undefined): Promise<FoundAccount[]> {
  const found: FoundAccount[] = []
  for (const root of roots) {
    let tdata: Tdata
    try {
      tdata = await Tdata.open({ path: root.dir, dataKey: root.dataKey, ignoreVersion: true, ...(passcode ? { passcode } : {}) })
    } catch (err) {
      if (isDecryptError(err)) {
        throw passcode
          ? new DomainError(422, 'passcode_invalid', 'Неверный код-пароль Telegram Desktop')
          : new DomainError(422, 'passcode_required', 'tdata защищена локальным код-паролем — введите его')
      }
      throw new DomainError(422, 'tdata_unreadable', `Не удалось прочитать tdata: ${err instanceof Error ? err.message : String(err)}`)
    }
    for (const index of tdata.keyData.order) {
      const session = await convertFromTdata(tdata, index)
      found.push({
        pathInArchive: relative(base, root.dir) || '.',
        accountIndex: index,
        tgUserId: session.self?.userId ?? 0,
        dcId: session.primaryDcs.main.id,
        session: writeStringSession(session),
      })
    }
  }
  return found
}

export interface ImportDeps {
  db: Db
  cipher: Cipher
  settings: SettingsService
}

/**
 * Unpacks a tdata zip in a temp dir (always removed), reads every account it holds and stores an import
 * draft: encrypted sessions waiting for the admin to pick proxies and confirm. No network involved.
 */
export async function createImport(
  deps: ImportDeps,
  input: { filename: string; data: Uint8Array; passcode?: string; adminId: string | null },
): Promise<ImportBatchDto> {
  const { db, cipher, settings } = deps
  if (input.data.length > settings.get('import.maxZipSizeMb') * MB) {
    throw new DomainError(422, 'zip_too_large', `Архив больше ${settings.get('import.maxZipSizeMb')} МБ`)
  }
  const dir = await mkdtemp(join(tmpdir(), 'accs-import-'))
  try {
    try {
      extractZip(input.data, dir, { maxFiles: settings.get('import.maxFiles'), maxUnpackedBytes: settings.get('import.maxUnpackedSizeMb') * MB })
    } catch (err) {
      if (err instanceof ZipLimitError) throw new DomainError(422, `zip_${err.kind}`, err.message)
      throw new DomainError(422, 'zip_invalid', 'Не удалось распаковать архив — это точно zip?')
    }
    const roots = await findTdataRoots(dir)
    if (roots.length === 0) throw new DomainError(422, 'tdata_not_found', 'В архиве нет tdata (не найден файл key_datas)')
    const found = await readAccounts(dir, roots, input.passcode)
    if (found.length === 0) throw new DomainError(422, 'tdata_empty', 'В tdata нет аккаунтов')

    const existing = await db
      .select({ id: accounts.id, tgUserId: accounts.tgUserId })
      .from(accounts)
      .where(inArray(accounts.tgUserId, found.map((f) => f.tgUserId)))
    const byUser = new Map(existing.map((a) => [a.tgUserId, a.id]))

    const expiresAt = new Date(Date.now() + parseDuration(settings.get('import.draftTtl')))
    const batchId = await db.transaction(async (tx) => {
      const [batch] = await tx.insert(importBatches).values({ adminId: input.adminId, filename: input.filename.slice(0, 255), expiresAt }).returning({ id: importBatches.id })
      await tx.insert(importItems).values(
        found.map((f) => ({
          batchId: batch!.id,
          pathInArchive: f.pathInArchive,
          accountIndex: f.accountIndex,
          tgUserId: f.tgUserId,
          dcId: f.dcId,
          sessionEnc: cipher.encrypt(f.session),
          duplicateOf: byUser.get(f.tgUserId) ?? null,
        })),
      )
      return batch!.id
    })
    return getImport(db, batchId)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

export async function getImport(db: Db, id: string): Promise<ImportBatchDto> {
  const [batch] = await db.select().from(importBatches).where(eq(importBatches.id, id))
  if (!batch) throw new DomainError(404, 'not_found', 'Импорт не найден или истёк')
  const items = await db
    .select({
      item: importItems,
      dup: { id: accounts.id, label: accounts.label, phone: accounts.phone },
    })
    .from(importItems)
    .leftJoin(accounts, eq(accounts.id, importItems.duplicateOf))
    .where(eq(importItems.batchId, id))
    .orderBy(importItems.pathInArchive, importItems.accountIndex)
  return {
    id: batch.id,
    filename: batch.filename,
    status: batch.status,
    createdAt: batch.createdAt.toISOString(),
    expiresAt: batch.expiresAt.toISOString(),
    items: items.map(({ item, dup }) => ({
      id: item.id,
      pathInArchive: item.pathInArchive,
      accountIndex: item.accountIndex,
      tgUserId: item.tgUserId,
      dcId: item.dcId,
      duplicateOf: dup?.id ? dup : null,
      decision: item.decision,
      accountId: item.accountId,
    })),
  }
}

/** Free proxies: working, enabled, not bound to an account. */
async function freeProxyIds(db: Db, exclude: string[]): Promise<string[]> {
  const rows = await db
    .select({ id: proxies.id })
    .from(proxies)
    .leftJoin(accounts, eq(accounts.proxyId, proxies.id))
    .where(and(eq(proxies.status, 'ok'), isNull(proxies.disabledAt), isNull(accounts.id), ...(exclude.length ? [notInArray(proxies.id, exclude)] : [])))
    .orderBy(proxies.latencyMs)
  return rows.map((r) => r.id)
}

export async function confirmImport(
  deps: ImportDeps,
  batchId: string,
  input: ConfirmImportInput,
): Promise<{ created: number; skipped: number; accountIds: string[] }> {
  const { db, settings } = deps
  const batch = await getImport(db, batchId)
  if (batch.status !== 'ready') throw new DomainError(409, 'already_confirmed', 'Этот импорт уже подтверждён')
  if (new Date(batch.expiresAt) < new Date()) throw new DomainError(409, 'expired', 'Импорт истёк — загрузите архив заново')

  const items = new Map(batch.items.map((i) => [i.id, i]))
  const device = {
    deviceModel: settings.get('telegram.desktop.deviceModel'),
    systemVersion: settings.get('telegram.desktop.systemVersion'),
    appVersion: settings.get('telegram.desktop.appVersion'),
    langCode: settings.get('telegram.desktop.langCode'),
  }
  const chosen = input.items.flatMap((d) => (d.decision === 'proxy' ? [d.proxyId] : []))
  const free = new Set(await freeProxyIds(db, []))
  for (const id of chosen) if (!free.has(id)) throw new DomainError(409, 'proxy_unavailable', 'Выбранный прокси не работает, отключён или уже занят')
  if (new Set(chosen).size !== chosen.length) throw new DomainError(409, 'proxy_unavailable', 'Один прокси выбран для двух аккаунтов')
  const autoPool = (await freeProxyIds(db, chosen)).reverse()

  const result = { created: 0, skipped: 0, accountIds: [] as string[] }
  await db.transaction(async (tx) => {
    for (const decision of input.items) {
      const item = items.get(decision.id)
      if (!item) throw new DomainError(400, 'unknown_item', 'Аккаунт не из этого импорта')
      if (decision.decision === 'skip') {
        await tx.update(importItems).set({ decision: 'skipped' }).where(eq(importItems.id, item.id))
        result.skipped++
        continue
      }
      if (item.duplicateOf) throw new DomainError(409, 'duplicate', `Аккаунт ${item.tgUserId} уже в панели — его можно только пропустить`)
      let proxyId: string | null = null
      if (decision.decision === 'proxy') proxyId = decision.proxyId
      if (decision.decision === 'auto') {
        proxyId = autoPool.pop() ?? null
        if (!proxyId) throw new DomainError(409, 'no_free_proxy', 'Свободных рабочих прокси не хватает на все аккаунты')
      }
      const [row] = await tx.select({ sessionEnc: importItems.sessionEnc }).from(importItems).where(eq(importItems.id, item.id))
      const [account] = await tx
        .insert(accounts)
        .values({
          tgUserId: item.tgUserId,
          dcId: item.dcId,
          source: 'tdata',
          clientProfile: 'desktop',
          device,
          connectionMode: proxyId ? 'proxy' : 'direct',
          proxyId,
          status: 'pending_check',
          sessionImportEnc: row!.sessionEnc,
        })
        .returning({ id: accounts.id })
      await tx.update(importItems).set({ decision: 'imported', accountId: account!.id }).where(eq(importItems.id, item.id))
      result.created++
      result.accountIds.push(account!.id)
    }
    await tx.update(importBatches).set({ status: 'confirmed' }).where(eq(importBatches.id, batchId))
  })
  return result
}
```

`apps/api/src/services/proxies.ts` — изменения

```diff
--- a/apps/api/src/services/proxies.ts
+++ b/apps/api/src/services/proxies.ts
@@ -10,7 +10,7 @@ import {
   type ProxyDto,
   type UpdateProxyInput,
 } from '@workspace/shared/proxies'
-import { eq, getTableColumns } from 'drizzle-orm'
+import { eq, getTableColumns } from '@workspace/db'
 import { DomainError } from '../lib/errors.ts'
 
 type ProxyRow = typeof proxies.$inferSelect
```

- [ ] **Шаг 5: Проверки**

```bash
fnm exec --using=26 pnpm typecheck
fnm exec --using=26 pnpm lint
fnm exec --using=26 npx vitest run --project api
# всё зелёное
```

- [ ] **Шаг 6: Коммит**

```bash
git add -A
git commit -F - <<'MSG'
feat(api): tdata import — zip upload with its own limit, safe streaming unzip, tdata roots at any depth, passcode, encrypted draft; confirm with proxy/auto/direct/skip
MSG
```

---

### Task 11: Менеджер аккаунтов в воркере

`TelegramSession` — узкий интерфейс к клиенту (реализация на mtcute, в тестах — `FakeSession`); `classifyTelegramError` раскладывает ошибки на `unauthorized` / `banned` / `frozen` / `network` / `other`. Менеджер: старт аккаунта только через назначенный прокси (недоступный прокси → `proxy_down`, напрямую сам никогда), импорт string session один раз (потом `session_import_enc = null`), профиль и заморозка (`help.getAppConfig`), статусы с аудитом `system` и событием `accounts.changed`, повторы с экспоненциальной задержкой для сетевых ошибок, реакция на падение/возврат/замену прокси, не больше `worker.connectConcurrency` подключений одновременно, команды `account.sync|stop|sessions|terminateSession`.

**Важно:** после `connect()` + `getMe()` вызывается `client.notifyLoggedIn(me.raw)` — так делает `client.start()`: запоминает «себя» и запускает цикл обновлений. Без этого живые сообщения не приходят. `client.start()` не используется: на мёртвой сессии он уходит в интерактивный вход. Найдено на живой проверке (задача 19), закреплено тестом `mtcute-session.test.ts`.

**Files:**
- Create: `apps/worker/src/accounts/manager.ts`
- Modify: `apps/worker/src/main.ts`
- Create: `apps/worker/src/telegram/errors.ts`
- Create: `apps/worker/src/telegram/mtcute-session.ts`
- Create: `apps/worker/src/telegram/session.ts`
- Test: `apps/worker/test/account-manager.test.ts`
- Test: `apps/worker/test/fake-session.ts`
- Test: `apps/worker/test/mtcute-session.test.ts`

**Interfaces:**
- Consumes: `createAccountStorage` (задача 9); `proxyTransport`, хуки `onDown/onUp` (задача 6); `onChanged` (задача 7); настройки `telegram.desktop.*`, `worker.connectConcurrency`.
- Produces:
  - `apps/worker/src/accounts/manager.ts`: `type AccountRow`; `type SessionFactory`; `interface AccountHooks`; `interface AccountManagerOptions`; `interface AccountManager`; `class AccountNotRunningError`; `createAccountManager(deps: WorkerDeps, factory: SessionFactory, hooks: AccountHooks = {}, options: AccountManagerOptions = {}): AccountManager`
  - `apps/worker/src/telegram/errors.ts`: `type TelegramErrorKind`; `classifyTelegramError(err: unknown): { kind: TelegramErrorKind; reason: string }`
  - `apps/worker/src/telegram/mtcute-session.ts`: `interface MtcuteSessionOptions`; `createMtcuteSession(options: MtcuteSessionOptions): TelegramSession`
  - `apps/worker/src/telegram/session.ts`: `interface SessionProfile`; `interface FreezeInfo`; `interface IncomingMessage`; `interface TelegramSession`

- [ ] **Шаг 1: Написать падающий тест**

`apps/worker/test/account-manager.test.ts` — новый файл

```ts
import { accounts, auditLog, desc, eq, proxies } from '@workspace/db'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { AccountNotRunningError, createAccountManager } from '../src/accounts/manager.ts'
import { fakeFactory, rpcError } from './fake-session.ts'
import { setupWorker, type TestWorker } from './helpers.ts'

let w: TestWorker
beforeAll(async () => {
  w = await setupWorker()
})
afterAll(async () => {
  await w.close()
})
beforeEach(async () => {
  await w.t.db.delete(accounts)
  await w.t.db.delete(proxies)
})

const device = { deviceModel: 'Desktop', systemVersion: 'Windows 11 x64', appVersion: '7.2.9 x64', langCode: 'ru' }
let nextUser = 1000
async function account(values: Partial<typeof accounts.$inferInsert> = {}) {
  const [row] = await w.t.db
    .insert(accounts)
    .values({ tgUserId: nextUser++, source: 'tdata', clientProfile: 'desktop', device, connectionMode: 'direct', ...values })
    .returning()
  return row!
}
async function proxy(values: Partial<typeof proxies.$inferInsert> = {}) {
  const [row] = await w.t.db
    .insert(proxies)
    .values({ source: 'manual', type: 'socks5', host: `10.7.7.${nextUser % 250}`, port: 1080, status: 'ok', username: 'u', passwordEnc: w.deps.cipher.encrypt('pw'), ...values })
    .returning()
  return row!
}
const read = async (id: string) => (await w.t.db.select().from(accounts).where(eq(accounts.id, id)))[0]!

describe('account manager', () => {
  it('starts an imported account through its proxy, imports the session once and stores the profile', async () => {
    const p = await proxy()
    const a = await account({ connectionMode: 'proxy', proxyId: p.id, sessionImportEnc: w.deps.cipher.encrypt('session-string') })
    const fake = fakeFactory()
    const onSessionStarted = vi.fn()
    const manager = createAccountManager(w.deps, fake.factory, { onSessionStarted }, { jitterMs: 0 })
    await manager.sync(a.id)

    expect(fake.last().importSession).toBe('session-string')
    expect(fake.last().proxy).toEqual({ type: 'socks5', host: p.host, port: 1080, username: 'u', password: 'pw' })
    expect(await read(a.id)).toMatchObject({ status: 'active', sessionImportEnc: null, phone: '77001234567', username: 'nox', firstName: 'Nox', dcId: 2 })
    expect(onSessionStarted).toHaveBeenCalledOnce()
    expect(manager.isRunning(a.id)).toBe(true)
    const [audit] = await w.t.db.select().from(auditLog).where(eq(auditLog.action, 'account.status')).orderBy(desc(auditLog.id)).limit(1)
    expect(audit).toMatchObject({ actorType: 'system', targetId: a.id, payload: { from: 'pending_check', to: 'active', reason: null } })
    await manager.stopAll()
  })

  it('marks a frozen account but keeps it running', async () => {
    const a = await account()
    const until = new Date('2026-12-01T00:00:00Z')
    const fake = fakeFactory((s) => (s.freeze = { since: new Date('2026-10-01T00:00:00Z'), until, appealUrl: 'https://t.me/spambot' }))
    const manager = createAccountManager(w.deps, fake.factory, {}, { jitterMs: 0 })
    await manager.sync(a.id)
    expect(await read(a.id)).toMatchObject({ status: 'frozen', frozenUntil: until })
    expect(manager.isRunning(a.id)).toBe(true)
    await manager.stopAll()
  })

  it('does not connect through a dead proxy and resumes when it comes back', async () => {
    const p = await proxy({ status: 'dead' })
    const a = await account({ connectionMode: 'proxy', proxyId: p.id })
    const fake = fakeFactory()
    const manager = createAccountManager(w.deps, fake.factory, {}, { jitterMs: 0 })
    await manager.sync(a.id)
    expect(fake.sessions).toHaveLength(0)
    expect(await read(a.id)).toMatchObject({ status: 'proxy_down', statusReason: 'Прокси не работает' })

    await w.t.db.update(proxies).set({ status: 'ok' }).where(eq(proxies.id, p.id))
    await manager.onProxyUp(p.id)
    expect(await read(a.id)).toMatchObject({ status: 'active' })

    await manager.onProxyDown(p.id)
    expect(fake.last().stopped).toBe(true)
    expect(await read(a.id)).toMatchObject({ status: 'proxy_down' })
    await manager.stopAll()
  })

  it('gives up on a revoked session and retries network failures', async () => {
    const revoked = await account()
    const flaky = await account()
    let attempts = 0
    const fake = fakeFactory((s) => {
      if (s.account.id === revoked.id) s.startResult = async () => Promise.reject(rpcError(401, 'AUTH_KEY_UNREGISTERED'))
      if (s.account.id === flaky.id) {
        const ok = s.startResult
        s.startResult = async () => (++attempts === 1 ? Promise.reject(new Error('connect ETIMEDOUT')) : ok())
      }
    })
    const manager = createAccountManager(w.deps, fake.factory, {}, { jitterMs: 0, retryDelaysMs: [30] })
    await manager.sync(revoked.id)
    await manager.sync(flaky.id)
    expect(await read(revoked.id)).toMatchObject({ status: 'unauthorized', statusReason: 'Сессия завершена в Telegram (ключ больше не действует)' })
    expect(await read(flaky.id)).toMatchObject({ status: 'error', statusReason: 'connect ETIMEDOUT' })
    await vi.waitFor(async () => expect((await read(flaky.id)).status).toBe('active'))
    expect(fake.sessions.filter((s) => s.account.id === revoked.id)).toHaveLength(1)
    await manager.stopAll()
  })

  it('reacts to errors reported later by a running client', async () => {
    const a = await account()
    const fake = fakeFactory()
    const manager = createAccountManager(w.deps, fake.factory, {}, { jitterMs: 0 })
    await manager.sync(a.id)
    fake.last().emitError(rpcError(401, 'SESSION_REVOKED'))
    await vi.waitFor(async () => expect((await read(a.id)).status).toBe('unauthorized'))
    expect(fake.last().stopped).toBe(true)
    expect(manager.isRunning(a.id)).toBe(false)
  })

  it('starts at most worker.connectConcurrency clients at a time', async () => {
    await w.deps.settings.update({ 'worker.connectConcurrency': 2 }, { adminId: null })
    for (let i = 0; i < 5; i++) await account({ status: 'active' })
    await account({ status: 'paused' })
    let inFlight = 0
    let peak = 0
    const fake = fakeFactory((s) => {
      const ok = s.startResult
      s.startResult = async () => {
        peak = Math.max(peak, ++inFlight)
        await new Promise((r) => setTimeout(r, 20))
        inFlight--
        return ok()
      }
    })
    const manager = createAccountManager(w.deps, fake.factory, {}, { jitterMs: 0 })
    await manager.startAll()
    expect(fake.sessions).toHaveLength(5)
    expect(peak).toBe(2)
    await manager.stopAll()
    await w.deps.settings.update({ 'worker.connectConcurrency': null }, { adminId: null })
  })

  it('logs out on request, lists sessions only for running accounts and refreshes profiles', async () => {
    const a = await account()
    const fake = fakeFactory((s) => (s.sessionList = [{ hash: '42', current: true } as never]))
    const manager = createAccountManager(w.deps, fake.factory, {}, { jitterMs: 0 })
    await expect(manager.sessions(a.id)).rejects.toBeInstanceOf(AccountNotRunningError)
    await manager.sync(a.id)
    expect(await manager.sessions(a.id)).toEqual([{ hash: '42', current: true }])
    await manager.terminateSession(a.id, '-77')
    expect(fake.last().terminated).toEqual(['-77'])

    fake.last().profile.mockResolvedValueOnce({ tgUserId: a.tgUserId, phone: '77001234567', username: 'renamed', firstName: 'Nox', lastName: null, isPremium: true, dcId: 2 })
    await manager.refreshProfiles()
    expect(await read(a.id)).toMatchObject({ username: 'renamed', isPremium: true })

    await manager.stop(a.id, true)
    expect(fake.last().loggedOut).toBe(true)
    expect(manager.isRunning(a.id)).toBe(false)
  })
})
```

`apps/worker/test/fake-session.ts` — новый файл

```ts
import { tl } from '@mtcute/core'
import type { AccountSessionDto } from '@workspace/shared/accounts'
import { vi } from 'vitest'
import type { AccountRow, SessionFactory } from '../src/accounts/manager.ts'
import type { ProxyEndpoint } from '../src/proxies/checker.ts'
import type { FreezeInfo, IncomingMessage, SessionProfile, TelegramSession } from '../src/telegram/session.ts'

export const rpcError = (code: number, text: string) => new tl.RpcError(code, text)

/** A scripted Telegram client: tests decide what start() does and push messages/errors in. */
export class FakeSession implements TelegramSession {
  account: AccountRow
  proxy: ProxyEndpoint | null
  importSession: string | null
  startResult: () => Promise<SessionProfile>
  freeze: FreezeInfo = { since: null, until: null, appealUrl: null }
  messageListeners: ((m: IncomingMessage) => void)[] = []
  errorListeners: ((err: unknown) => void)[] = []
  historyMessages: IncomingMessage[] = []
  stopped = false
  loggedOut = false
  resolved = new Map<string, number>([['VerificationCodes', 489000]])
  sessionList: AccountSessionDto[] = []
  terminated: string[] = []

  constructor(account: AccountRow, ctx: { proxy: ProxyEndpoint | null; importSession: string | null }, profile: Partial<SessionProfile> = {}) {
    this.account = account
    this.proxy = ctx.proxy
    this.importSession = ctx.importSession
    const full: SessionProfile = { tgUserId: account.tgUserId, phone: '77001234567', username: 'nox', firstName: 'Nox', lastName: null, isPremium: false, dcId: 2, ...profile }
    this.startResult = async () => full
  }

  start = vi.fn(() => this.startResult())
  profile = vi.fn(() => this.startResult())
  freezeInfo = vi.fn(async () => this.freeze)
  resolveUserId = vi.fn(async (username: string) => {
    const id = this.resolved.get(username)
    if (id === undefined) throw rpcError(400, 'USERNAME_NOT_OCCUPIED')
    return id
  })
  history = vi.fn(async (userId: number, afterId: number) => this.historyMessages.filter((m) => m.senderId === userId && m.id > afterId))
  onMessage(listener: (m: IncomingMessage) => void) {
    this.messageListeners.push(listener)
  }
  onError(listener: (err: unknown) => void) {
    this.errorListeners.push(listener)
  }
  sessions = vi.fn(async () => this.sessionList)
  terminateSession = vi.fn(async (hash: string) => {
    this.terminated.push(hash)
  })
  logOut = vi.fn(async () => {
    this.loggedOut = true
  })
  stop = vi.fn(async () => {
    this.stopped = true
  })

  emitMessage(m: IncomingMessage) {
    for (const l of this.messageListeners) l(m)
  }
  emitError(err: unknown) {
    for (const l of this.errorListeners) l(err)
  }
}

/** Factory recording every session it made; `configure` scripts each new one. */
export function fakeFactory(configure: (s: FakeSession) => void = () => {}) {
  const sessions: FakeSession[] = []
  const factory: SessionFactory = (account, ctx) => {
    const session = new FakeSession(account, ctx)
    configure(session)
    sessions.push(session)
    return session
  }
  return { factory, sessions, last: () => sessions.at(-1)! }
}
```

`apps/worker/test/mtcute-session.test.ts` — новый файл

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest'

const client = {
  importSession: vi.fn(async () => {}),
  connect: vi.fn(async () => {}),
  getMe: vi.fn(async () => ({ id: 42, phoneNumber: '77001234567', username: null, firstName: 'Тест', lastName: null, isPremium: false, dcId: 2, raw: { _: 'user', id: 42 } })),
  notifyLoggedIn: vi.fn(async () => {}),
}
vi.mock('@mtcute/node', () => ({ TelegramClient: vi.fn(function TelegramClient() { return client }) }))

const { createMtcuteSession } = await import('../src/telegram/mtcute-session.ts')

const options = {
  apiId: 2040,
  apiHash: 'hash',
  device: { deviceModel: 'Desktop', systemVersion: 'Windows 11 x64', appVersion: '7.2.9 x64', langCode: 'ru' },
  storage: {} as never,
  proxy: null,
}

beforeEach(() => vi.clearAllMocks())

describe('mtcute session', () => {
  it('starts the updates loop after connecting: without it no live messages arrive', async () => {
    const profile = await createMtcuteSession({ ...options, importSession: null }).start()
    expect(client.connect).toHaveBeenCalled()
    expect(client.notifyLoggedIn).toHaveBeenCalledWith({ _: 'user', id: 42 })
    expect(profile).toEqual({ tgUserId: 42, phone: '77001234567', username: null, firstName: 'Тест', lastName: null, isPremium: false, dcId: 2 })
    expect(client.importSession).not.toHaveBeenCalled()
  })

  it('applies an imported session before connecting', async () => {
    await createMtcuteSession({ ...options, importSession: 'session-string' }).start()
    expect(client.importSession).toHaveBeenCalledWith('session-string', true)
    expect(client.importSession.mock.invocationCallOrder[0]!).toBeLessThan(client.connect.mock.invocationCallOrder[0]!)
  })

  it('does not report a logged-in client when the session is dead', async () => {
    client.getMe.mockRejectedValueOnce(Object.assign(new Error('AUTH_KEY_UNREGISTERED'), { code: 401 }))
    await expect(createMtcuteSession({ ...options, importSession: null }).start()).rejects.toThrow('AUTH_KEY_UNREGISTERED')
    expect(client.notifyLoggedIn).not.toHaveBeenCalled()
  })
})
```

- [ ] **Шаг 2: Убедиться, что тест падает**

```bash
fnm exec --using=26 npx vitest run --project worker apps/worker/test/account-manager.test.ts apps/worker/test/mtcute-session.test.ts
# FAIL: Cannot find module '../src/accounts/manager.ts'
```

- [ ] **Шаг 3: Реализация**

`apps/worker/src/accounts/manager.ts` — новый файл

```ts
import { accounts, and, eq, inArray, notInArray, proxies } from '@workspace/db'
import { writeAudit } from '@workspace/server'
import { RUNNING_STATUSES, type AccountSessionDto, type AccountStatus } from '@workspace/shared/accounts'
import type { WorkerDeps } from '../deps.ts'
import type { ProxyEndpoint } from '../proxies/checker.ts'
import { classifyTelegramError } from '../telegram/errors.ts'
import type { TelegramSession } from '../telegram/session.ts'

export type AccountRow = typeof accounts.$inferSelect

export type SessionFactory = (account: AccountRow, ctx: { proxy: ProxyEndpoint | null; importSession: string | null }) => TelegramSession

export interface AccountHooks {
  /** the client is up: the codes module subscribes and catches up on missed messages */
  onSessionStarted?: (account: AccountRow, session: TelegramSession) => Promise<void> | void
  /** after the new status is stored: notifications */
  onStatusChanged?: (account: AccountRow, from: AccountStatus, to: AccountStatus) => Promise<void> | void
}

export interface AccountManagerOptions {
  /** waits before reconnect attempts after a network error; the last one repeats */
  retryDelaysMs?: number[]
  /** random spread between starts so dozens of clients do not connect in one burst */
  jitterMs?: number
}

export interface AccountManager {
  startAll(): Promise<void>
  /** reload one account from the database and run it if its status says so */
  sync(accountId: string): Promise<void>
  stop(accountId: string, logout?: boolean): Promise<void>
  onProxyDown(proxyId: string): Promise<void>
  onProxyUp(proxyId: string): Promise<void>
  onProxyChanged(proxyId: string): Promise<void>
  refreshProfiles(): Promise<void>
  sessions(accountId: string): Promise<AccountSessionDto[]>
  terminateSession(accountId: string, hash: string): Promise<void>
  isRunning(accountId: string): boolean
  stopAll(): Promise<void>
}

const DEFAULT_RETRY_DELAYS = [60_000, 120_000, 300_000, 600_000, 1_800_000]
const FROZEN_REASON = 'Telegram ограничил аккаунт (заморозка): коды продолжают приходить'

export class AccountNotRunningError extends Error {
  constructor() {
    super('Аккаунт сейчас не подключён')
    this.name = 'AccountNotRunningError'
  }
}

export function createAccountManager(deps: WorkerDeps, factory: SessionFactory, hooks: AccountHooks = {}, options: AccountManagerOptions = {}): AccountManager {
  const { db, cipher, settings, logger, bus } = deps
  const retryDelays = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS
  const jitterMs = options.jitterMs ?? 1_500
  const running = new Map<string, TelegramSession>()
  const retries = new Map<string, { attempt: number; timer?: NodeJS.Timeout }>()
  let shuttingDown = false

  const load = async (id: string) => (await db.select().from(accounts).where(eq(accounts.id, id)))[0]

  async function setStatus(account: AccountRow, status: AccountStatus, reason: string | null): Promise<AccountRow> {
    if (account.status === status && account.statusReason === reason) return account
    const [updated] = await db
      .update(accounts)
      .set({ status, statusReason: reason, statusChangedAt: new Date() })
      .where(eq(accounts.id, account.id))
      .returning()
    if (!updated) return account
    if (account.status !== status) {
      await writeAudit(db, { actor: { type: 'system' }, action: 'account.status', targetType: 'account', targetId: account.id, payload: { from: account.status, to: status, reason }, result: 'ok' }).catch(
        (err: unknown) => logger.error({ err }, 'accounts: failed to audit a status change'),
      )
      await hooks.onStatusChanged?.(updated, account.status, status)
    }
    await bus.publish({ type: 'accounts.changed', ids: [account.id] })
    return updated
  }

  /** The proxy the account must use, or why it cannot connect now. Direct accounts get null. */
  async function proxyFor(account: AccountRow): Promise<{ ok: true; endpoint: ProxyEndpoint | null } | { ok: false; reason: string }> {
    if (account.connectionMode === 'direct') return { ok: true, endpoint: null }
    if (!account.proxyId) return { ok: false, reason: 'Прокси не назначен' }
    const [proxy] = await db.select().from(proxies).where(eq(proxies.id, account.proxyId))
    if (!proxy) return { ok: false, reason: 'Прокси удалён' }
    if (proxy.disabledAt) return { ok: false, reason: 'Прокси отключён' }
    if (proxy.status === 'dead') return { ok: false, reason: 'Прокси не работает' }
    if (proxy.status === 'expired') return { ok: false, reason: 'Срок прокси истёк' }
    if (proxy.status === 'provisioning') return { ok: false, reason: 'Прокси ещё не выдан провайдером' }
    return {
      ok: true,
      endpoint: { type: proxy.type, host: proxy.host, port: proxy.port, username: proxy.username, password: proxy.passwordEnc ? cipher.decrypt(proxy.passwordEnc) : null },
    }
  }

  function clearRetry(id: string): void {
    const retry = retries.get(id)
    if (retry?.timer) clearTimeout(retry.timer)
    retries.delete(id)
  }

  function scheduleRetry(id: string): void {
    if (shuttingDown) return
    const attempt = (retries.get(id)?.attempt ?? 0) + 1
    const delay = retryDelays[Math.min(attempt - 1, retryDelays.length - 1)]!
    const timer = setTimeout(() => {
      retries.set(id, { attempt })
      void start(id)
    }, delay)
    timer.unref()
    retries.set(id, { attempt, timer })
  }

  async function stopSession(id: string, logout = false): Promise<void> {
    const session = running.get(id)
    if (!session) return
    running.delete(id)
    if (logout) await session.logOut().catch((err: unknown) => logger.warn({ err, accountId: id }, 'accounts: log out failed'))
    await session.stop().catch((err: unknown) => logger.warn({ err, accountId: id }, 'accounts: stop failed'))
  }

  async function handleError(id: string, err: unknown): Promise<void> {
    const { kind, reason } = classifyTelegramError(err)
    const account = await load(id)
    if (!account) return
    logger.warn({ accountId: id, kind, reason }, 'accounts: client error')
    if (kind === 'unauthorized' || kind === 'banned') {
      clearRetry(id)
      await stopSession(id)
      await setStatus(account, kind, reason)
      return
    }
    if (kind === 'frozen') {
      const session = running.get(id)
      const freeze = session ? await session.freezeInfo().catch(() => null) : null
      await db.update(accounts).set({ frozenUntil: freeze?.until ?? null }).where(eq(accounts.id, id))
      await setStatus(account, 'frozen', FROZEN_REASON)
      return
    }
    await stopSession(id)
    // a network failure through a proxy that has meanwhile died is the proxy's fault, not the account's
    const proxy = await proxyFor(account)
    if (!proxy.ok) {
      clearRetry(id)
      await setStatus(account, 'proxy_down', proxy.reason)
      return
    }
    await setStatus(account, 'error', reason)
    scheduleRetry(id)
  }

  async function start(id: string): Promise<void> {
    if (shuttingDown || running.has(id)) return
    let account = await load(id)
    if (!account || !(RUNNING_STATUSES.includes(account.status) || account.status === 'proxy_down')) return
    const proxy = await proxyFor(account)
    if (!proxy.ok) {
      await setStatus(account, 'proxy_down', proxy.reason)
      return
    }
    let session: TelegramSession
    try {
      session = factory(account, { proxy: proxy.endpoint, importSession: account.sessionImportEnc ? cipher.decrypt(account.sessionImportEnc) : null })
    } catch (err) {
      // e.g. the account's api_id is not configured: nothing to retry until settings change
      await setStatus(account, 'error', err instanceof Error ? err.message : String(err))
      return
    }
    // claimed before the first await: a second start() of the same account is a no-op
    running.set(id, session)
    try {
      const profile = await session.start()
      const freeze = await session.freezeInfo().catch(() => null)
      const [updated] = await db
        .update(accounts)
        .set({
          // the session now lives in the mtcute storage: never import the tdata copy again
          sessionImportEnc: null,
          tgUserId: profile.tgUserId,
          phone: profile.phone,
          username: profile.username,
          firstName: profile.firstName,
          lastName: profile.lastName,
          isPremium: profile.isPremium,
          dcId: profile.dcId ?? account.dcId,
          lastOkAt: new Date(),
          frozenUntil: freeze?.since ? freeze.until : null,
        })
        .where(eq(accounts.id, id))
        .returning()
      account = updated ?? account
      clearRetry(id)
      session.onError((err) => void handleError(id, err))
      account = await setStatus(account, freeze?.since ? 'frozen' : 'active', freeze?.since ? FROZEN_REASON : null)
      logger.info({ accountId: id, dcId: account.dcId, proxyId: account.proxyId, status: account.status }, 'accounts: connected')
      await hooks.onSessionStarted?.(account, session)
    } catch (err) {
      running.delete(id)
      await session.stop().catch(() => {})
      await handleError(id, err)
    }
  }

  async function accountsOnProxy(proxyId: string, statuses?: readonly AccountStatus[]): Promise<AccountRow[]> {
    return db
      .select()
      .from(accounts)
      .where(and(eq(accounts.proxyId, proxyId), statuses ? inArray(accounts.status, [...statuses]) : notInArray(accounts.status, ['paused', 'unauthorized', 'banned'])))
  }

  return {
    async startAll() {
      const rows = await db
        .select({ id: accounts.id })
        .from(accounts)
        .where(inArray(accounts.status, [...RUNNING_STATUSES, 'proxy_down']))
      const queue = rows.map((r) => r.id)
      const concurrency = Math.max(1, settings.get('worker.connectConcurrency'))
      await Promise.all(
        Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
          for (let id = queue.shift(); id; id = queue.shift()) {
            if (jitterMs > 0) await new Promise((resolve) => setTimeout(resolve, Math.random() * jitterMs))
            await start(id).catch((err: unknown) => logger.error({ err, accountId: id }, 'accounts: start crashed'))
          }
        }),
      )
    },
    async sync(accountId) {
      clearRetry(accountId)
      await stopSession(accountId)
      await start(accountId)
    },
    async stop(accountId, logout = false) {
      clearRetry(accountId)
      await stopSession(accountId, logout)
    },
    async onProxyDown(proxyId) {
      for (const account of await accountsOnProxy(proxyId)) {
        clearRetry(account.id)
        await stopSession(account.id)
        const proxy = await proxyFor(account)
        await setStatus(account, 'proxy_down', proxy.ok ? 'Прокси не работает' : proxy.reason)
      }
    },
    async onProxyUp(proxyId) {
      for (const account of await accountsOnProxy(proxyId, ['proxy_down'])) await start(account.id)
    },
    async onProxyChanged(proxyId) {
      for (const account of await accountsOnProxy(proxyId)) {
        if (running.has(account.id)) {
          await stopSession(account.id)
          await start(account.id)
        }
      }
    },
    async refreshProfiles() {
      for (const [id, session] of [...running]) {
        try {
          const [profile, freeze] = await Promise.all([session.profile(), session.freezeInfo().catch(() => null)])
          await db
            .update(accounts)
            .set({ phone: profile.phone, username: profile.username, firstName: profile.firstName, lastName: profile.lastName, isPremium: profile.isPremium, lastOkAt: new Date(), frozenUntil: freeze?.since ? freeze.until : null })
            .where(eq(accounts.id, id))
          const account = await load(id)
          if (account && freeze) await setStatus(account, freeze.since ? 'frozen' : 'active', freeze.since ? FROZEN_REASON : null)
        } catch (err) {
          await handleError(id, err)
        }
      }
    },
    async sessions(accountId) {
      const session = running.get(accountId)
      if (!session) throw new AccountNotRunningError()
      return session.sessions()
    },
    async terminateSession(accountId, hash) {
      const session = running.get(accountId)
      if (!session) throw new AccountNotRunningError()
      await session.terminateSession(hash)
    },
    isRunning: (accountId) => running.has(accountId),
    async stopAll() {
      shuttingDown = true
      for (const id of [...retries.keys()]) clearRetry(id)
      await Promise.allSettled([...running.keys()].map((id) => stopSession(id)))
    },
  }
}
```

`apps/worker/src/main.ts` — изменения

```diff
--- a/apps/worker/src/main.ts
+++ b/apps/worker/src/main.ts
@@ -7,7 +7,9 @@ import { acquireSingletonLock } from './lock.ts'
 import { createMtcuteProxyChecker } from './proxies/checker.ts'
 import { createProxyHealth } from './proxies/health.ts'
 import { syncProxyStore } from './proxies/proxy-store.ts'
-import { prepareMtcuteStorage } from './telegram/storage.ts'
+import { createAccountManager, type SessionFactory } from './accounts/manager.ts'
+import { createMtcuteSession } from './telegram/mtcute-session.ts'
+import { createAccountStorage, prepareMtcuteStorage } from './telegram/storage.ts'
 import { createWorkerRuntime } from './runtime.ts'
 
 const env = loadEnv()
@@ -36,26 +38,51 @@ const settings = await SettingsService.create({ db: database.db, cipher, bus, lo
 await prepareMtcuteStorage(database.pool, database.db, cipher)
 
 const deps: WorkerDeps = { env, db: database.db, pool: database.pool, redis, queueRedis, bus, settings, cipher, logger }
+/** tdata accounts keep Telegram Desktop's identity; QR accounts use the owner's own api_id */
+const sessionFactory: SessionFactory = (account, ctx) => {
+  const own = account.clientProfile === 'own'
+  const apiId = own ? settings.get('telegram.own.apiId') : settings.get('telegram.desktop.apiId')
+  const apiHash = own ? settings.get('telegram.own.apiHash') : settings.get('telegram.desktop.apiHash')
+  if (!apiId || !apiHash) throw new Error(own ? 'Не задан свой api_id / api_hash (Настройки → Telegram)' : 'Не задан Desktop api_id / api_hash')
+  return createMtcuteSession({
+    apiId,
+    apiHash,
+    device: account.device,
+    storage: createAccountStorage(database.pool, database.db, cipher, account.id),
+    proxy: ctx.proxy,
+    importSession: ctx.importSession,
+  })
+}
+const accountManager = createAccountManager(deps, sessionFactory)
+
 const proxyChecker = createMtcuteProxyChecker(() => ({ apiId: settings.get('telegram.desktop.apiId'), apiHash: settings.get('telegram.desktop.apiHash') }))
-const proxyHealth = createProxyHealth(deps, proxyChecker)
+const proxyHealth = createProxyHealth(deps, proxyChecker, { onDown: accountManager.onProxyDown, onUp: accountManager.onProxyUp })
+const proxyStoreHooks = { onChanged: accountManager.onProxyChanged, onDown: accountManager.onProxyDown }
 
 const runtime = createWorkerRuntime(deps, {
   commands: {
     'proxy.check': async ({ proxyId }) => proxyHealth.checkById(proxyId),
-    'proxy.sync': async () => syncProxyStore(deps, fetch),
+    'proxy.sync': async () => syncProxyStore(deps, fetch, proxyStoreHooks),
+    'account.sync': async ({ accountId }) => accountManager.sync(accountId),
+    'account.stop': async ({ accountId, logout }) => accountManager.stop(accountId, logout),
+    'account.sessions': async ({ accountId }) => accountManager.sessions(accountId),
+    'account.terminateSession': async ({ accountId, hash }) => accountManager.terminateSession(accountId, hash),
   },
   maintenance: {
     'proxies.checkDue': async () => {
       await proxyHealth.checkDue()
     },
     'proxies.sync': async () => {
-      await syncProxyStore(deps, fetch)
+      await syncProxyStore(deps, fetch, proxyStoreHooks)
     },
+    'accounts.refreshProfiles': async () => accountManager.refreshProfiles(),
   },
 })
 await runtime.start()
 const stopHeartbeat = startWorkerHeartbeat(redis, env.APP_VERSION)
 logger.info('worker: started')
+// connects in the background: commands and maintenance keep flowing meanwhile
+accountManager.startAll().catch((err: unknown) => logger.error({ err }, 'worker: starting accounts failed'))
 
 let stopping = false
 async function shutdown(signal: string): Promise<void> {
@@ -66,6 +93,7 @@ async function shutdown(signal: string): Promise<void> {
   setTimeout(() => process.exit(1), 25_000).unref()
   try {
     await runtime.stop()
+    await accountManager.stopAll()
     await stopHeartbeat()
     settings.close()
     await bus.close()
```

`apps/worker/src/telegram/errors.ts` — новый файл

```ts
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
```

`apps/worker/src/telegram/mtcute-session.ts` — новый файл

```ts
import { Long, tl } from '@mtcute/core'
import { tlJsonToJson } from '@mtcute/core/utils.js'
import { TelegramClient } from '@mtcute/node'
import type { AccountDevice } from '@workspace/db'
import type { AccountSessionDto } from '@workspace/shared/accounts'
import type { ProxyEndpoint } from '../proxies/checker.ts'
import { proxyTransport } from '../proxies/checker.ts'
import type { FreezeInfo, SessionProfile, TelegramSession } from './session.ts'
import type { ITelegramStorageProvider } from '@mtcute/core'

export interface MtcuteSessionOptions {
  apiId: number
  apiHash: string
  device: AccountDevice
  storage: ITelegramStorageProvider
  proxy: ProxyEndpoint | null
  /** string session from a tdata import, applied once before connecting */
  importSession: string | null
}

const iso = (seconds: number) => new Date(seconds * 1000).toISOString()

export function createMtcuteSession(options: MtcuteSessionOptions): TelegramSession {
  const client = new TelegramClient({
    apiId: options.apiId,
    apiHash: options.apiHash,
    storage: options.storage,
    ...(options.proxy ? { transport: proxyTransport(options.proxy) } : {}),
    initConnectionOptions: {
      deviceModel: options.device.deviceModel,
      systemVersion: options.device.systemVersion,
      appVersion: options.device.appVersion,
      langCode: options.device.langCode,
      systemLangCode: options.device.langCode,
      langPack: 'tdesktop',
    },
    logLevel: 1,
  })

  const toProfile = (me: Awaited<ReturnType<TelegramClient['getMe']>>): SessionProfile => {
    return {
      tgUserId: me.id,
      phone: me.phoneNumber ?? null,
      username: me.username ?? null,
      firstName: me.firstName || null,
      lastName: me.lastName ?? null,
      isPremium: me.isPremium,
      dcId: me.dcId ?? null,
    }
  }
  const profile = async (): Promise<SessionProfile> => toProfile(await client.getMe())

  return {
    async start() {
      if (options.importSession) await client.importSession(options.importSession, true)
      await client.connect()
      const me = await client.getMe()
      // what client.start() does after a successful getMe: remember «self» and start the updates loop —
      // without it no live messages arrive. start() itself is not used: on a dead session it falls back
      // to an interactive login.
      await client.notifyLoggedIn(me.raw)
      return toProfile(me)
    },
    profile,
    async freezeInfo(): Promise<FreezeInfo> {
      const res = await client.call({ _: 'help.getAppConfig', hash: 0 })
      if (res._ !== 'help.appConfig') return { since: null, until: null, appealUrl: null }
      const config = tlJsonToJson(res.config) as Record<string, unknown>
      const since = Number(config.freeze_since_date ?? 0)
      const until = Number(config.freeze_until_date ?? 0)
      return {
        since: since ? new Date(since * 1000) : null,
        until: until ? new Date(until * 1000) : null,
        appealUrl: typeof config.freeze_appeal_url === 'string' ? config.freeze_appeal_url : null,
      }
    },
    async resolveUserId(username) {
      const peer = await client.resolveUser(username)
      if (peer._ === 'inputUser') return peer.userId
      throw new Error(`@${username} is not a user`)
    },
    async history(userId, afterId, limit) {
      const page = await client.getHistory(userId, { minId: afterId, limit })
      return page
        .filter((m) => !m.isOutgoing && m.id > afterId)
        .map((m) => ({ id: m.id, date: m.date, text: m.text, senderId: m.sender.id, markup: (m.raw as { replyMarkup?: unknown }).replyMarkup ?? null }))
        .sort((a, b) => a.id - b.id)
    },
    onMessage(listener) {
      client.onNewMessage.add((m) => {
        if (m.isOutgoing) return
        listener({ id: m.id, date: m.date, text: m.text, senderId: m.sender.id, markup: (m.raw as { replyMarkup?: unknown }).replyMarkup ?? null })
      })
    },
    onError(listener) {
      client.onError.add((err) => listener(err))
    },
    async sessions(): Promise<AccountSessionDto[]> {
      const res = await client.call({ _: 'account.getAuthorizations' })
      return res.authorizations.map((a: tl.RawAuthorization) => ({
        hash: a.hash.toString(),
        current: Boolean(a.current),
        official: Boolean(a.officialApp),
        appName: a.appName,
        appVersion: a.appVersion,
        deviceModel: a.deviceModel,
        platform: a.platform,
        systemVersion: a.systemVersion,
        ip: a.ip,
        country: a.country,
        region: a.region,
        createdAt: iso(a.dateCreated),
        activeAt: iso(a.dateActive),
      }))
    },
    async terminateSession(hash) {
      await client.call({ _: 'account.resetAuthorization', hash: Long.fromString(hash) })
    },
    async logOut() {
      await client.logOut()
    },
    async stop() {
      await client.destroy()
    },
  }
}
```

`apps/worker/src/telegram/session.ts` — новый файл

```ts
import type { AccountSessionDto } from '@workspace/shared/accounts'

export interface SessionProfile {
  tgUserId: number
  phone: string | null
  username: string | null
  firstName: string | null
  lastName: string | null
  isPremium: boolean
  dcId: number | null
}

export interface FreezeInfo {
  since: Date | null
  until: Date | null
  appealUrl: string | null
}

export interface IncomingMessage {
  id: number
  date: Date
  text: string
  senderId: number
  /** raw reply markup (inline buttons), if any — the code may sit in a Copy Code button */
  markup: unknown
}

/** One live account client. The worker talks to Telegram only through this, so tests can fake it. */
export interface TelegramSession {
  /** connect (importing the tdata session the first time) and return who we are */
  start(): Promise<SessionProfile>
  profile(): Promise<SessionProfile>
  freezeInfo(): Promise<FreezeInfo>
  /** numeric id of a user by @username (cached by mtcute's peer storage) */
  resolveUserId(username: string): Promise<number>
  /** incoming messages from `userId` with id > `afterId`, oldest first */
  history(userId: number, afterId: number, limit: number): Promise<IncomingMessage[]>
  onMessage(listener: (message: IncomingMessage) => void): void
  /** failures outside a request we made (revoked key noticed by the updates loop, etc.) */
  onError(listener: (err: unknown) => void): void
  sessions(): Promise<AccountSessionDto[]>
  terminateSession(hash: string): Promise<void>
  logOut(): Promise<void>
  stop(): Promise<void>
}
```

- [ ] **Шаг 4: Проверки**

```bash
fnm exec --using=26 pnpm typecheck
fnm exec --using=26 pnpm lint
fnm exec --using=26 npx vitest run --project worker
# всё зелёное
```

- [ ] **Шаг 5: Коммит**

```bash
git add -A
git commit -F - <<'MSG'
feat(worker): account manager — mtcute sessions with Desktop/own profiles, tdata session import, profile and freeze, status machine with audit, retries, proxy down/up/changed, commands
MSG
```

---

### Task 12: Коды из @VerificationCodes

Сборщик подключается к каждому запущенному аккаунту (`onSessionStarted`): резолвит `@VerificationCodes`, слушает новые сообщения только от него и догружает историю после простоя (до 100 сообщений новее последнего сохранённого). Сохранение идемпотентно, новое сообщение → событие `code.new` и хук `onCode` (уведомления, задача 13). Код — из кнопки Copy (`inlineButtonTypeCopy.copyText`, поиск по всей разметке), иначе первое отдельно стоящее число из 4–8 цифр; полный текст хранится всегда. `GET /api/codes`: фильтр `accountId`, курсор `before`, `limit`. Ежечасная уборка: коды старше `retention.codeMessagesDays`, истёкшие черновики импорта, истёкшие сессии админов. В лог — `codes: watching @VerificationCodes` с числом догруженных.

**Files:**
- Modify: `apps/api/src/app.ts`
- Create: `apps/api/src/routes/codes.ts`
- Test: `apps/api/test/codes.test.ts`
- Create: `apps/worker/src/codes/collector.ts`
- Create: `apps/worker/src/codes/extract.ts`
- Create: `apps/worker/src/housekeeping.ts`
- Modify: `apps/worker/src/main.ts`
- Test: `apps/worker/test/codes.test.ts`

**Interfaces:**
- Consumes: `code_messages` (задача 1); `TelegramSession.resolveUserId/history/onMessage`, `AccountHooks.onSessionStarted` (задача 11); `MAINTENANCE_TASKS.housekeeping` (задача 4).
- Produces:
  - `apps/api/src/routes/codes.ts`: `codeRoutes`
  - `apps/worker/src/codes/collector.ts`: `type CodeRow`; `interface CodeHooks`; `HISTORY_LIMIT`; `createCodeCollector(deps: WorkerDeps, hooks: CodeHooks = {})`
  - `apps/worker/src/codes/extract.ts`: `extractCode(text: string, markup: unknown): string | null`
  - `apps/worker/src/housekeeping.ts`: `housekeeping(deps: WorkerDeps, now = new Date()): Promise<{ codes: number; imports: number; sessions: number }>`

- [ ] **Шаг 1: Написать падающий тест**

`apps/api/test/codes.test.ts` — новый файл

```ts
import { accounts, codeMessages } from '@workspace/db'
import type { CodeDto } from '@workspace/shared/accounts'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { loginAs, send, setupApp, type TestApp } from './helpers.ts'

let ta: TestApp
let cookie: string
beforeAll(async () => {
  ta = await setupApp()
  cookie = (await loginAs(ta)).cookie
})
afterAll(async () => {
  await ta.close()
})

const device = { deviceModel: 'Desktop', systemVersion: 'Windows 11 x64', appVersion: '7.2.9 x64', langCode: 'ru' }

describe('codes api', () => {
  it('lists the newest codes first with the account, filters by account and pages back', async () => {
    const [a, b] = await ta.t.db
      .insert(accounts)
      .values([
        { tgUserId: 1, phone: '77001234567', label: 'main', source: 'tdata', clientProfile: 'desktop', device, connectionMode: 'direct' },
        { tgUserId: 2, username: 'second', source: 'qr', clientProfile: 'own', device, connectionMode: 'direct' },
      ])
      .returning()
    const base = Date.parse('2026-10-03T10:00:00Z')
    await ta.t.db.insert(codeMessages).values([
      { accountId: a!.id, tgMessageId: 1, date: new Date(base), text: 'Your code is 111111', code: '111111' },
      { accountId: b!.id, tgMessageId: 1, date: new Date(base + 1000), text: 'Your code is 222222', code: '222222' },
      { accountId: a!.id, tgMessageId: 2, date: new Date(base + 2000), text: 'no code here', code: null },
    ])
    const get = async (query = '') => ((await (await send(ta.app, `/api/codes${query}`, { cookie })).json()) as { items: CodeDto[] }).items

    const all = await get()
    expect(all.map((c) => c.code)).toEqual([null, '222222', '111111'])
    expect(all[1]).toMatchObject({ account: { label: null, phone: null, username: 'second' }, text: 'Your code is 222222', notifiedAt: null })
    expect((await get(`?accountId=${a!.id}`)).map((c) => c.tgMessageId)).toEqual([2, 1])
    expect((await get(`?limit=1&before=${all[0]!.id}`)).map((c) => c.code)).toEqual(['222222'])
    expect((await send(ta.app, '/api/codes?limit=0', { cookie })).status).toBe(400)
  })
})
```

`apps/worker/test/codes.test.ts` — новый файл

```ts
import { accounts, adminSessions, admins, codeMessages, eq, importBatches } from '@workspace/db'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createAccountManager } from '../src/accounts/manager.ts'
import { createCodeCollector } from '../src/codes/collector.ts'
import { extractCode } from '../src/codes/extract.ts'
import { housekeeping } from '../src/housekeeping.ts'
import { fakeFactory } from './fake-session.ts'
import { setupWorker, type TestWorker } from './helpers.ts'

describe('extractCode', () => {
  // layer 229: keyboardInlineButton { type: inlineButtonTypeCopy { copyText } }
  const markup = (code: string) => ({
    _: 'replyInlineMarkup',
    rows: [{ _: 'keyboardButtonRow', buttons: [{ _: 'keyboardInlineButton', text: 'Copy Code', type: { _: 'inlineButtonTypeCopy', copyText: code } }] }],
  })
  it('takes the code from the Copy Code button', () => {
    expect(extractCode('Your code is 575571', markup('575571'))).toBe('575571')
    expect(extractCode('Код: см. кнопку', markup('A1B2C3'))).toBe('A1B2C3')
  })
  it('falls back to the first standalone 4–8 digit number', () => {
    expect(extractCode('Your code is 276350', null)).toBe('276350')
    expect(extractCode('Код подтверждения для +77001234567: 4093', null)).toBe('4093')
    expect(extractCode('Order 2026-10-03, code 469894.', null)).toBe('2026')
    expect(extractCode('Добро пожаловать!', null)).toBeNull()
  })
})

let w: TestWorker
beforeAll(async () => {
  w = await setupWorker()
})
afterAll(async () => {
  await w.close()
})
beforeEach(async () => {
  await w.t.db.delete(accounts)
})

const device = { deviceModel: 'Desktop', systemVersion: 'Windows 11 x64', appVersion: '7.2.9 x64', langCode: 'ru' }
const insertAccount = async () =>
  (await w.t.db.insert(accounts).values({ tgUserId: Math.floor(Math.random() * 1e9), source: 'tdata', clientProfile: 'desktop', device, connectionMode: 'direct' }).returning())[0]!
const msg = (id: number, text: string, senderId = 489000, ageMs = 0) => ({ id, date: new Date(Date.now() - ageMs), text, senderId, markup: null })

describe('code collector', () => {
  it('stores live codes from @VerificationCodes only, once, and announces them', async () => {
    const a = await insertAccount()
    const onCode = vi.fn()
    const collector = createCodeCollector(w.deps, { onCode })
    const fake = fakeFactory()
    const manager = createAccountManager(w.deps, fake.factory, { onSessionStarted: collector.attach }, { jitterMs: 0 })
    const events = vi.fn()
    const off = w.deps.bus.subscribe(events)
    try {
      await manager.sync(a.id)
      const session = fake.last()
      session.emitMessage(msg(10, 'Your code is 575571'))
      session.emitMessage(msg(11, 'hello from a friend', 12345))
      session.emitMessage(msg(10, 'Your code is 575571'))
      await vi.waitFor(() => expect(onCode).toHaveBeenCalledOnce())
      const rows = await w.t.db.select().from(codeMessages).where(eq(codeMessages.accountId, a.id))
      expect(rows.map((r) => [r.tgMessageId, r.code])).toEqual([[10, '575571']])
      expect(onCode).toHaveBeenCalledWith(expect.objectContaining({ code: '575571' }), expect.objectContaining({ id: a.id }), true)
      await vi.waitFor(() => expect(events).toHaveBeenCalledWith(expect.objectContaining({ type: 'code.new', accountId: a.id, code: '575571' })))
    } finally {
      off()
      await manager.stopAll()
    }
  })

  it('catches up on messages missed while offline, after the last stored one', async () => {
    const a = await insertAccount()
    await w.t.db.insert(codeMessages).values({ accountId: a.id, tgMessageId: 20, date: new Date(Date.now() - 3_600_000), text: 'Your code is 111111', code: '111111' })
    const onCode = vi.fn()
    const collector = createCodeCollector(w.deps, { onCode })
    const fake = fakeFactory((s) => {
      s.historyMessages = [msg(19, 'old 999999', 489000, 7_200_000), msg(21, 'Your code is 276350', 489000, 600_000), msg(22, 'Your code is 409369')]
    })
    const manager = createAccountManager(w.deps, fake.factory, { onSessionStarted: collector.attach }, { jitterMs: 0 })
    try {
      await manager.sync(a.id)
      expect(fake.last().history).toHaveBeenCalledWith(489000, 20, 100)
      const codes = (await w.t.db.select().from(codeMessages).where(eq(codeMessages.accountId, a.id))).map((r) => r.code).sort()
      expect(codes).toEqual(['111111', '276350', '409369'])
      expect(onCode.mock.calls.map((c) => [c[0].code, c[2]])).toEqual([
        ['276350', false],
        ['409369', false],
      ])
    } finally {
      await manager.stopAll()
    }
  })
})

describe('housekeeping', () => {
  it('drops old codes, expired import drafts and expired admin sessions', async () => {
    const a = await insertAccount()
    const now = new Date()
    await w.t.db.insert(codeMessages).values([
      { accountId: a.id, tgMessageId: 1, date: new Date(now.getTime() - 31 * 86_400_000), text: 'old' },
      { accountId: a.id, tgMessageId: 2, date: new Date(now.getTime() - 86_400_000), text: 'fresh' },
    ])
    await w.t.db.insert(importBatches).values([
      { filename: 'gone.zip', expiresAt: new Date(now.getTime() - 1000) },
      { filename: 'kept.zip', expiresAt: new Date(now.getTime() + 60_000) },
    ])
    const [admin] = await w.t.db.insert(admins).values({ login: 'hk', passwordHash: 'x' }).returning()
    await w.t.db.insert(adminSessions).values([
      { adminId: admin!.id, tokenHash: 'expired', expiresAt: new Date(now.getTime() - 1000) },
      { adminId: admin!.id, tokenHash: 'live', expiresAt: new Date(now.getTime() + 60_000) },
    ])
    expect(await housekeeping(w.deps, now)).toEqual({ codes: 1, imports: 1, sessions: 1 })
    expect((await w.t.db.select().from(codeMessages)).map((r) => r.text)).toEqual(['fresh'])
    expect((await w.t.db.select().from(importBatches)).map((b) => b.filename)).toEqual(['kept.zip'])
  })
})
```

- [ ] **Шаг 2: Убедиться, что тест падает**

```bash
fnm exec --using=26 npx vitest run --project worker apps/worker/test/codes.test.ts && fnm exec --using=26 npx vitest run --project api apps/api/test/codes.test.ts
# FAIL: Cannot find module '../src/codes/extract.ts'
```

- [ ] **Шаг 3: Реализация**

`apps/api/src/app.ts` — изменения

```diff
--- a/apps/api/src/app.ts
+++ b/apps/api/src/app.ts
@@ -13,6 +13,7 @@ import { originGuard } from './middleware/origin.ts'
 import { adminRoutes } from './routes/admins.ts'
 import { auditRoutes } from './routes/audit.ts'
 import { authRoutes } from './routes/auth.ts'
+import { codeRoutes } from './routes/codes.ts'
 import { eventRoutes } from './routes/events.ts'
 import { healthRoutes } from './routes/health.ts'
 import { importRoutes } from './routes/imports.ts'
@@ -66,6 +67,7 @@ export function createApp(deps: AppDeps): Hono<AppEnv> {
   api.route('/', settingsRoutes)
   api.route('/', proxyRoutes)
   api.route('/', importRoutes)
+  api.route('/', codeRoutes)
   api.route('/', auditRoutes)
   api.route('/', eventRoutes)
   api.all('*', (c) => c.json({ error: 'not_found' }, 404))
```

`apps/api/src/routes/codes.ts` — новый файл

```ts
import { zValidator } from '@hono/zod-validator'
import { accounts, and, codeMessages, desc, eq, lt, type SQL } from '@workspace/db'
import { codesQuery, type CodeDto } from '@workspace/shared/accounts'
import { Hono } from 'hono'
import type { AppEnv } from '../deps.ts'
import { validationHook } from './validation.ts'

export const codeRoutes = new Hono<AppEnv>().get('/codes', zValidator('query', codesQuery, validationHook), async (c) => {
  const { accountId, before, limit } = c.req.valid('query')
  const where: SQL[] = []
  if (accountId) where.push(eq(codeMessages.accountId, accountId))
  if (before) where.push(lt(codeMessages.id, before))
  const rows = await c
    .get('deps')
    .db.select({ code: codeMessages, account: { label: accounts.label, phone: accounts.phone, username: accounts.username } })
    .from(codeMessages)
    .innerJoin(accounts, eq(accounts.id, codeMessages.accountId))
    .where(where.length ? and(...where) : undefined)
    .orderBy(desc(codeMessages.id))
    .limit(limit)
  const items: CodeDto[] = rows.map(({ code, account }) => ({
    id: code.id,
    accountId: code.accountId,
    account,
    tgMessageId: code.tgMessageId,
    date: code.date.toISOString(),
    text: code.text,
    code: code.code,
    notifiedAt: code.notifiedAt?.toISOString() ?? null,
  }))
  return c.json({ items })
})
```

`apps/worker/src/codes/collector.ts` — новый файл

```ts
import { codeMessages, desc, eq } from '@workspace/db'
import { CODE_SOURCE_USERNAME } from '@workspace/shared/accounts'
import type { WorkerDeps } from '../deps.ts'
import type { AccountRow } from '../accounts/manager.ts'
import type { IncomingMessage, TelegramSession } from '../telegram/session.ts'
import { extractCode } from './extract.ts'

export type CodeRow = typeof codeMessages.$inferSelect

export interface CodeHooks {
  /** a code message we had not seen; `live` is false for messages caught up from history */
  onCode?: (code: CodeRow, account: AccountRow, live: boolean) => Promise<void> | void
}

/** Messages fetched per account when catching up after downtime. */
export const HISTORY_LIMIT = 100

/**
 * Reads codes from the @VerificationCodes chat of every running account: live messages as they come, and
 * on each (re)connect everything newer than the last stored message. Storing is idempotent (unique key).
 */
export function createCodeCollector(deps: WorkerDeps, hooks: CodeHooks = {}) {
  const { db, logger, bus } = deps

  async function save(account: AccountRow, message: IncomingMessage, live: boolean): Promise<void> {
    const [row] = await db
      .insert(codeMessages)
      .values({ accountId: account.id, tgMessageId: message.id, date: message.date, text: message.text, code: extractCode(message.text, message.markup) })
      .onConflictDoNothing()
      .returning()
    if (!row) return
    await bus.publish({ type: 'code.new', id: row.id, accountId: account.id, code: row.code, date: row.date.toISOString() })
    await hooks.onCode?.(row, account, live)
  }

  return {
    /** AccountHooks.onSessionStarted */
    async attach(account: AccountRow, session: TelegramSession): Promise<void> {
      let sourceId: number
      try {
        sourceId = await session.resolveUserId(CODE_SOURCE_USERNAME)
      } catch (err) {
        logger.warn({ err, accountId: account.id }, 'codes: cannot resolve @VerificationCodes')
        return
      }
      session.onMessage((message) => {
        if (message.senderId !== sourceId) return
        save(account, message, true).catch((err: unknown) => logger.error({ err, accountId: account.id }, 'codes: failed to store a message'))
      })
      const [last] = await db
        .select({ id: codeMessages.tgMessageId })
        .from(codeMessages)
        .where(eq(codeMessages.accountId, account.id))
        .orderBy(desc(codeMessages.tgMessageId))
        .limit(1)
      try {
        const missed = await session.history(sourceId, last?.id ?? 0, HISTORY_LIMIT)
        for (const message of missed) await save(account, message, false)
        logger.info({ accountId: account.id, caughtUp: missed.length }, 'codes: watching @VerificationCodes')
      } catch (err) {
        logger.warn({ err, accountId: account.id }, 'codes: history catch-up failed')
      }
    },
  }
}
```

`apps/worker/src/codes/extract.ts` — новый файл

```ts
const CODE_IN_TEXT = /(?<![\d])\d{4,8}(?![\d])/

/** The first `copyText` anywhere in the reply markup (inlineButtonTypeCopy, or the older keyboardButtonCopy). */
function copyTextIn(value: unknown, depth = 0): string | null {
  if (depth > 8 || value === null || typeof value !== 'object') return null
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = copyTextIn(item, depth + 1)
      if (found) return found
    }
    return null
  }
  const record = value as Record<string, unknown>
  if (typeof record.copyText === 'string' && record.copyText.trim()) return record.copyText.trim()
  for (const key of Object.keys(record)) {
    const found = copyTextIn(record[key], depth + 1)
    if (found) return found
  }
  return null
}

/**
 * The code of a @VerificationCodes message: what its «Copy Code» button copies, else the first standalone
 * 4–8 digit number of the text («Your code is 575571»), else null (the text is kept anyway).
 */
export function extractCode(text: string, markup: unknown): string | null {
  const fromButton = copyTextIn(markup)
  if (fromButton && fromButton.length <= 32) return fromButton
  return CODE_IN_TEXT.exec(text)?.[0] ?? null
}
```

`apps/worker/src/housekeeping.ts` — новый файл

```ts
import { adminSessions, codeMessages, importBatches, lt } from '@workspace/db'
import type { WorkerDeps } from './deps.ts'

/** Hourly cleanup: old codes (retention.codeMessagesDays), unconfirmed imports past their TTL, expired admin sessions. */
export async function housekeeping(deps: WorkerDeps, now = new Date()): Promise<{ codes: number; imports: number; sessions: number }> {
  const { db, settings } = deps
  const codesBefore = new Date(now.getTime() - settings.get('retention.codeMessagesDays') * 86_400_000)
  const codes = await db.delete(codeMessages).where(lt(codeMessages.date, codesBefore)).returning({ id: codeMessages.id })
  // import items (with their encrypted sessions) go with the batch (on delete cascade)
  const imports = await db.delete(importBatches).where(lt(importBatches.expiresAt, now)).returning({ id: importBatches.id })
  const sessions = await db.delete(adminSessions).where(lt(adminSessions.expiresAt, now)).returning({ id: adminSessions.id })
  return { codes: codes.length, imports: imports.length, sessions: sessions.length }
}
```

`apps/worker/src/main.ts` — изменения

```diff
--- a/apps/worker/src/main.ts
+++ b/apps/worker/src/main.ts
@@ -8,6 +8,8 @@ import { createMtcuteProxyChecker } from './proxies/checker.ts'
 import { createProxyHealth } from './proxies/health.ts'
 import { syncProxyStore } from './proxies/proxy-store.ts'
 import { createAccountManager, type SessionFactory } from './accounts/manager.ts'
+import { createCodeCollector } from './codes/collector.ts'
+import { housekeeping } from './housekeeping.ts'
 import { createMtcuteSession } from './telegram/mtcute-session.ts'
 import { createAccountStorage, prepareMtcuteStorage } from './telegram/storage.ts'
 import { createWorkerRuntime } from './runtime.ts'
@@ -53,7 +55,8 @@ const sessionFactory: SessionFactory = (account, ctx) => {
     importSession: ctx.importSession,
   })
 }
-const accountManager = createAccountManager(deps, sessionFactory)
+const codeCollector = createCodeCollector(deps)
+const accountManager = createAccountManager(deps, sessionFactory, { onSessionStarted: codeCollector.attach })
 
 const proxyChecker = createMtcuteProxyChecker(() => ({ apiId: settings.get('telegram.desktop.apiId'), apiHash: settings.get('telegram.desktop.apiHash') }))
 const proxyHealth = createProxyHealth(deps, proxyChecker, { onDown: accountManager.onProxyDown, onUp: accountManager.onProxyUp })
@@ -76,6 +79,9 @@ const runtime = createWorkerRuntime(deps, {
       await syncProxyStore(deps, fetch, proxyStoreHooks)
     },
     'accounts.refreshProfiles': async () => accountManager.refreshProfiles(),
+    housekeeping: async () => {
+      logger.info(await housekeeping(deps), 'worker: housekeeping done')
+    },
   },
 })
 await runtime.start()
```

- [ ] **Шаг 4: Проверки**

```bash
fnm exec --using=26 pnpm typecheck
fnm exec --using=26 pnpm lint
fnm exec --using=26 npx vitest run --project api --project worker
# всё зелёное
```

- [ ] **Шаг 5: Коммит**

```bash
git add -A
git commit -F - <<'MSG'
feat: codes from @VerificationCodes — Copy Code button or text, live + history catch-up, code.new events, codes API; hourly housekeeping (old codes, import drafts, expired admin sessions)
MSG
```

---

### Task 13: Уведомления в канал

Очередь `notify`: в задаче только id, данные читаются при отправке. Код — одна строка HTML `<code>+77001234567</code> получен код <code>575571</code>` (нет телефона — метка или `@username`; код не извлёкся — «получено сообщение» и начало текста). Догруженные из истории коды старше `notify.maxAge` в канал не уходят. Предупреждения: аккаунт `proxy_down` / `unauthorized` / `banned` / `frozen` и прокси, истекающие в ближайшие `proxy.expiryWarnDays` (по одному разу на прокси). Bot API: 4xx — без повторов (`UnrecoverableError`), 429 и 5xx — повтор с backoff. Ничего не отправляется при `notify.enabled = false`, без токена или chat id; типы событий — `notify.events`.

**Files:**
- Modify: `apps/worker/src/main.ts`
- Create: `apps/worker/src/notify/bot-api.ts`
- Create: `apps/worker/src/notify/format.ts`
- Create: `apps/worker/src/notify/notifier.ts`
- Test: `apps/worker/test/notifier.test.ts`

**Interfaces:**
- Consumes: `CodeHooks.onCode` (задача 12); `AccountHooks.onStatusChanged` (задача 11); настройки `notify.*`.
- Produces:
  - `apps/worker/src/notify/bot-api.ts`: `type BotFetch`; `class BotRateLimitError`; `sendBotMessage(fetchFn: BotFetch, token: string, chatId: string, html: string): Promise<void>`
  - `apps/worker/src/notify/format.ts`: `accountTag(account: AccountLike): string`; `formatCodeMessage(account: AccountLike, code: string | null, text: string): string`; `formatStatusMessage(account: AccountLike, status: AccountStatus, reason: string | null): string`; `formatProxyExpiringMessage(rows: { host: string; port: number; expiresAt: Date; account: AccountLike | null }[]): string`
  - `apps/worker/src/notify/notifier.ts`: `NOTIFY_QUEUE`; `type NotifyJob`; `createNotifier(deps: WorkerDeps, fetchFn: BotFetch)`

- [ ] **Шаг 1: Написать падающий тест**

`apps/worker/test/notifier.test.ts` — новый файл

```ts
import { accounts, codeMessages, eq, proxies } from '@workspace/db'
import { Queue, UnrecoverableError } from 'bullmq'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { BotRateLimitError, sendBotMessage, type BotFetch } from '../src/notify/bot-api.ts'
import { formatCodeMessage } from '../src/notify/format.ts'
import { createNotifier, NOTIFY_QUEUE, type NotifyJob } from '../src/notify/notifier.ts'
import { setupWorker, type TestWorker } from './helpers.ts'

describe('message format', () => {
  it('is one short line: phone, then the code, both monospace', () => {
    expect(formatCodeMessage({ phone: '77001234567', label: 'main', username: null, tgUserId: 1 }, '575571', 'Your code is 575571')).toBe(
      '<code>+77001234567</code> получен код <code>575571</code>',
    )
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
      expect(texts[0]).toMatch(/^⏳ Скоро заканчивается оплата прокси:\n• <code>194\.53\.188\.22:50101<\/code> до .+ — <code>\+77005550000<\/code>$/)
    } finally {
      await notifier.stop()
    }
  })
})
```

- [ ] **Шаг 2: Убедиться, что тест падает**

```bash
fnm exec --using=26 npx vitest run --project worker apps/worker/test/notifier.test.ts
# FAIL: Cannot find module '../src/notify/format.ts'
```

- [ ] **Шаг 3: Реализация**

`apps/worker/src/main.ts` — изменения

```diff
--- a/apps/worker/src/main.ts
+++ b/apps/worker/src/main.ts
@@ -10,6 +10,7 @@ import { syncProxyStore } from './proxies/proxy-store.ts'
 import { createAccountManager, type SessionFactory } from './accounts/manager.ts'
 import { createCodeCollector } from './codes/collector.ts'
 import { housekeeping } from './housekeeping.ts'
+import { createNotifier } from './notify/notifier.ts'
 import { createMtcuteSession } from './telegram/mtcute-session.ts'
 import { createAccountStorage, prepareMtcuteStorage } from './telegram/storage.ts'
 import { createWorkerRuntime } from './runtime.ts'
@@ -55,8 +56,9 @@ const sessionFactory: SessionFactory = (account, ctx) => {
     importSession: ctx.importSession,
   })
 }
-const codeCollector = createCodeCollector(deps)
-const accountManager = createAccountManager(deps, sessionFactory, { onSessionStarted: codeCollector.attach })
+const notifier = createNotifier(deps, fetch)
+const codeCollector = createCodeCollector(deps, { onCode: notifier.onCode })
+const accountManager = createAccountManager(deps, sessionFactory, { onSessionStarted: codeCollector.attach, onStatusChanged: notifier.onStatusChanged })
 
 const proxyChecker = createMtcuteProxyChecker(() => ({ apiId: settings.get('telegram.desktop.apiId'), apiHash: settings.get('telegram.desktop.apiHash') }))
 const proxyHealth = createProxyHealth(deps, proxyChecker, { onDown: accountManager.onProxyDown, onUp: accountManager.onProxyUp })
@@ -80,11 +82,14 @@ const runtime = createWorkerRuntime(deps, {
     },
     'accounts.refreshProfiles': async () => accountManager.refreshProfiles(),
     housekeeping: async () => {
-      logger.info(await housekeeping(deps), 'worker: housekeeping done')
+      const removed = await housekeeping(deps)
+      const expiringProxies = await notifier.warnExpiringProxies()
+      logger.info({ ...removed, expiringProxies }, 'worker: housekeeping done')
     },
   },
 })
 await runtime.start()
+notifier.start()
 const stopHeartbeat = startWorkerHeartbeat(redis, env.APP_VERSION)
 logger.info('worker: started')
 // connects in the background: commands and maintenance keep flowing meanwhile
@@ -100,6 +105,7 @@ async function shutdown(signal: string): Promise<void> {
   try {
     await runtime.stop()
     await accountManager.stopAll()
+    await notifier.stop()
     await stopHeartbeat()
     settings.close()
     await bus.close()
```

`apps/worker/src/notify/bot-api.ts` — новый файл

```ts
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
```

`apps/worker/src/notify/format.ts` — новый файл

```ts
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
```

`apps/worker/src/notify/notifier.ts` — новый файл

```ts
import { accounts, and, codeMessages, eq, gt, inArray, isNotNull, isNull, lte, ne, proxies } from '@workspace/db'
import { QUEUE_PREFIX } from '@workspace/server'
import type { AccountStatus } from '@workspace/shared/accounts'
import type { NotifyEvent } from '@workspace/shared/settings'
import { parseDuration } from '@workspace/shared/duration'
import { Queue, Worker, type Job } from 'bullmq'
import type { AccountRow } from '../accounts/manager.ts'
import type { CodeRow } from '../codes/collector.ts'
import type { WorkerDeps } from '../deps.ts'
import { sendBotMessage, type BotFetch } from './bot-api.ts'
import { formatCodeMessage, formatProxyExpiringMessage, formatStatusMessage } from './format.ts'

export const NOTIFY_QUEUE = 'notify'

/** Only ids travel through Redis: the text is built from the database when the job runs. */
export type NotifyJob =
  | { kind: 'code'; codeId: number }
  | { kind: 'status'; accountId: string; status: AccountStatus; reason: string | null }
  | { kind: 'proxyExpiring'; proxyIds: string[] }

const STATUS_EVENTS: Partial<Record<AccountStatus, NotifyEvent>> = {
  proxy_down: 'proxy_down',
  unauthorized: 'unauthorized',
  banned: 'banned',
  frozen: 'frozen',
}

export function createNotifier(deps: WorkerDeps, fetchFn: BotFetch) {
  const { db, settings, logger } = deps
  const prefix = deps.queuePrefix ?? QUEUE_PREFIX
  const queue = new Queue<NotifyJob>(NOTIFY_QUEUE, { connection: deps.queueRedis, prefix })
  let worker: Worker<NotifyJob> | undefined

  /** On and configured, and this kind of event is wanted. */
  function wants(event: NotifyEvent): boolean {
    return settings.get('notify.enabled') && Boolean(settings.get('notify.botToken')) && Boolean(settings.get('notify.chatId')) && settings.get('notify.events').includes(event)
  }

  const enqueue = (job: NotifyJob) =>
    queue.add(job.kind, job, { attempts: 6, backoff: { type: 'exponential', delay: 5_000 }, removeOnComplete: true, removeOnFail: 100 })

  async function send(html: string): Promise<void> {
    const token = settings.get('notify.botToken')
    const chatId = settings.get('notify.chatId')
    if (!token || !chatId) return
    await sendBotMessage(fetchFn, token, chatId, html)
  }

  async function process(job: NotifyJob): Promise<void> {
    if (job.kind === 'code') {
      const [row] = await db
        .select({ code: codeMessages, account: accounts })
        .from(codeMessages)
        .innerJoin(accounts, eq(accounts.id, codeMessages.accountId))
        .where(eq(codeMessages.id, job.codeId))
      if (!row || row.code.notifiedAt) return
      await send(formatCodeMessage(row.account, row.code.code, row.code.text))
      await db.update(codeMessages).set({ notifiedAt: new Date() }).where(eq(codeMessages.id, job.codeId))
      return
    }
    if (job.kind === 'status') {
      const [account] = await db.select().from(accounts).where(eq(accounts.id, job.accountId))
      if (account) await send(formatStatusMessage(account, job.status, job.reason))
      return
    }
    if (job.proxyIds.length === 0) return
    const rows = await db
      .select({ host: proxies.host, port: proxies.port, expiresAt: proxies.expiresAt, account: accounts })
      .from(proxies)
      .leftJoin(accounts, eq(accounts.proxyId, proxies.id))
      .where(inArray(proxies.id, job.proxyIds))
      .orderBy(proxies.expiresAt)
    const list = rows.flatMap((r) => (r.expiresAt ? [{ host: r.host, port: r.port, expiresAt: r.expiresAt, account: r.account }] : []))
    if (list.length > 0) await send(formatProxyExpiringMessage(list))
  }

  return {
    process,
    /** CodeHooks.onCode: live codes always, caught-up ones only while still fresh (notify.maxAge) */
    async onCode(code: CodeRow, _account: AccountRow, live: boolean): Promise<void> {
      if (!wants('code')) return
      if (!live && Date.now() - code.date.getTime() > parseDuration(settings.get('notify.maxAge'))) return
      await enqueue({ kind: 'code', codeId: code.id })
    },
    /** AccountHooks.onStatusChanged */
    async onStatusChanged(account: AccountRow, _from: AccountStatus, to: AccountStatus): Promise<void> {
      const event = STATUS_EVENTS[to]
      if (event && wants(event)) await enqueue({ kind: 'status', accountId: account.id, status: to, reason: account.statusReason })
    },
    /** Housekeeping: one message listing the proxies whose paid period ends within proxy.expiryWarnDays. */
    async warnExpiringProxies(now = new Date()): Promise<number> {
      const until = new Date(now.getTime() + settings.get('proxy.expiryWarnDays') * 86_400_000)
      const due = await db
        .update(proxies)
        .set({ expiryWarnedAt: now })
        .where(and(isNotNull(proxies.expiresAt), lte(proxies.expiresAt, until), gt(proxies.expiresAt, now), isNull(proxies.expiryWarnedAt), ne(proxies.status, 'expired')))
        .returning({ id: proxies.id })
      if (due.length > 0 && wants('proxy_expiring')) await enqueue({ kind: 'proxyExpiring', proxyIds: due.map((d) => d.id) })
      return due.length
    },
    start(): void {
      worker = new Worker<NotifyJob>(NOTIFY_QUEUE, async (job: Job<NotifyJob>) => process(job.data), { connection: deps.queueRedis.duplicate(), prefix, concurrency: 1 })
      worker.on('failed', (job, err) => logger.warn({ err: err.message, kind: job?.data.kind }, 'notify: delivery failed'))
    },
    async stop(): Promise<void> {
      await worker?.close()
      await queue.close()
    },
  }
}
```

- [ ] **Шаг 4: Проверки**

```bash
fnm exec --using=26 pnpm typecheck
fnm exec --using=26 pnpm lint
fnm exec --using=26 npx vitest run --project worker
# всё зелёное
```

- [ ] **Шаг 5: Коммит**

```bash
git add -A
git commit -F - <<'MSG'
feat(worker): notifications to the Telegram channel — «+phone получен код 575571», account status warnings, expiring proxies; BullMQ retries, ids-only jobs
MSG
```

---

### Task 14: API аккаунтов

Список с прокси и временем последнего кода, карточка, метка и заметка, смена прокси или «напрямую» (только явным `proxyId: null`; прокси — свободный и рабочий: `ok`/`unchecked`/`failing`, не отключён, не занят), пауза/возобновление/переподключение через воркер. Удаление: сначала воркер отпускает клиент (`account.stop`, `call`), с `?logout=true` — только если выход в Telegram действительно прошёл, иначе 409 `logout_failed` и данные остаются; затем удаляются аккаунт, ключи и строки mtcute. Активные сессии (`account.getAuthorizations`) — чтение пишется в аудит; завершение по `hash`. Команды воркеру возвращают структурные результаты (`{ error: 'not_running' }`).

**Files:**
- Modify: `packages/shared/src/commands.ts`
- Modify: `packages/db/src/index.ts`
- Modify: `apps/api/src/app.ts`
- Create: `apps/api/src/routes/accounts.ts`
- Create: `apps/api/src/services/accounts.ts`
- Test: `apps/api/test/accounts.test.ts`
- Modify: `apps/worker/src/accounts/manager.ts`
- Modify: `apps/worker/src/main.ts`
- Test (modify): `apps/worker/test/account-manager.test.ts`

**Interfaces:**
- Consumes: `createAccountManager` и его команды (задача 11); `deleteAccountStorage`-логика (задача 9); `codes` (задача 12).
- Produces:
  - `packages/shared/src/commands.ts`: `interface AccountStopResult`; `type AccountSessionsResult`; `type TerminateSessionResult`
  - `apps/api/src/routes/accounts.ts`: `accountRoutes`
  - `apps/api/src/services/accounts.ts`: `listAccounts(db: Db): Promise<AccountDto[]>`; `getAccount(db: Db, id: string): Promise<AccountDto>`; `updateAccount(db: Db, id: string, input: UpdateAccountInput): Promise<AccountDto>`; `setAccountProxy(db: Db, id: string, proxyId: string | null): Promise<AccountDto>`; `pauseAccount(db: Db, id: string): Promise<AccountDto>`; `resumeAccount(db: Db, id: string): Promise<AccountDto>`; `deleteAccountData(db: Db, id: string): Promise<void>`

- [ ] **Шаг 1: Написать падающий тест**

`apps/api/test/accounts.test.ts` — новый файл

```ts
import { accounts, auditLog, codeMessages, desc, eq, proxies } from '@workspace/db'
import type { AccountDto } from '@workspace/shared/accounts'
import type { WorkerCommand } from '@workspace/shared/commands'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { loginAs, send, setupApp, type TestApp } from './helpers.ts'

let ta: TestApp
let cookie: string
beforeAll(async () => {
  ta = await setupApp()
  cookie = (await loginAs(ta)).cookie
})
afterAll(async () => {
  await ta.close()
})
beforeEach(async () => {
  await ta.t.db.delete(accounts)
  await ta.t.db.delete(proxies)
  ta.commands.sent = []
  ta.commands.respond = () => null
})

const device = { deviceModel: 'Desktop', systemVersion: 'Windows 11 x64', appVersion: '7.2.9 x64', langCode: 'ru' }
let user = 100
const insertAccount = async (values: Partial<typeof accounts.$inferInsert> = {}) =>
  (await ta.t.db.insert(accounts).values({ tgUserId: user++, source: 'tdata', clientProfile: 'desktop', device, connectionMode: 'direct', ...values }).returning())[0]!
let host = 1
const insertProxy = async (values: Partial<typeof proxies.$inferInsert> = {}) =>
  (await ta.t.db.insert(proxies).values({ source: 'manual', type: 'socks5', host: `10.5.5.${host++}`, port: 1080, status: 'ok', tgCountry: 'KZ', ...values }).returning())[0]!
const json = async <T,>(res: Response) => (await res.json()) as T

describe('accounts api', () => {
  it('lists accounts with their proxy and the time of the last code', async () => {
    const p = await insertProxy()
    const a = await insertAccount({ connectionMode: 'proxy', proxyId: p.id, phone: '77001234567', status: 'active' })
    await ta.t.db.insert(codeMessages).values({ accountId: a.id, tgMessageId: 1, date: new Date('2026-10-03T10:00:00Z'), text: 't', code: '1' })
    const { items } = await json<{ items: AccountDto[] }>(await send(ta.app, '/api/accounts', { cookie }))
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ id: a.id, phone: '77001234567', status: 'active', proxy: { id: p.id, host: p.host, status: 'ok', tgCountry: 'KZ' }, lastCodeAt: '2026-10-03T10:00:00.000Z', device })
    expect((await send(ta.app, `/api/accounts/${a.id}`, { cookie })).status).toBe(200)
  })

  it('edits the label and note', async () => {
    const a = await insertAccount()
    const updated = await json<AccountDto>(await send(ta.app, `/api/accounts/${a.id}`, { cookie, method: 'PATCH', body: { label: 'Основной', note: '' } }))
    expect(updated).toMatchObject({ label: 'Основной', note: null })
  })

  it('moves an account to a free proxy or to direct, and refuses busy or broken proxies', async () => {
    const a = await insertAccount({ status: 'proxy_down', connectionMode: 'proxy' })
    const free = await insertProxy()
    const busy = await insertProxy()
    await insertAccount({ connectionMode: 'proxy', proxyId: busy.id })
    const dead = await insertProxy({ status: 'dead' })

    for (const proxyId of [busy.id, dead.id]) {
      const res = await send(ta.app, `/api/accounts/${a.id}/proxy`, { cookie, method: 'PUT', body: { proxyId } })
      expect(res.status).toBe(409)
    }
    const moved = await json<AccountDto>(await send(ta.app, `/api/accounts/${a.id}/proxy`, { cookie, method: 'PUT', body: { proxyId: free.id } }))
    expect(moved).toMatchObject({ connectionMode: 'proxy', proxy: { id: free.id }, status: 'pending_check' })
    expect(ta.commands.sent).toEqual([{ type: 'account.sync', accountId: a.id }])
    const direct = await json<AccountDto>(await send(ta.app, `/api/accounts/${a.id}/proxy`, { cookie, method: 'PUT', body: { proxyId: null } }))
    expect(direct).toMatchObject({ connectionMode: 'direct', proxy: null })
  })

  it('pauses and resumes through the worker', async () => {
    const a = await insertAccount({ status: 'active' })
    expect(await json<AccountDto>(await send(ta.app, `/api/accounts/${a.id}/pause`, { cookie, method: 'POST' }))).toMatchObject({ status: 'paused' })
    expect(await json<AccountDto>(await send(ta.app, `/api/accounts/${a.id}/resume`, { cookie, method: 'POST' }))).toMatchObject({ status: 'pending_check' })
    expect(ta.commands.sent).toEqual([
      { type: 'account.stop', accountId: a.id, logout: false },
      { type: 'account.sync', accountId: a.id },
    ])
    const revoked = await insertAccount({ status: 'unauthorized' })
    expect((await send(ta.app, `/api/accounts/${revoked.id}/pause`, { cookie, method: 'POST' })).status).toBe(409)
  })

  it('deletes after the worker let go; with logout only when it really logged out', async () => {
    const a = await insertAccount()
    await ta.t.db.insert(codeMessages).values({ accountId: a.id, tgMessageId: 1, date: new Date(), text: 't' })
    ta.commands.respond = () => ({ stopped: false, loggedOut: false })
    const refused = await send(ta.app, `/api/accounts/${a.id}?logout=true`, { cookie, method: 'DELETE' })
    expect(refused.status).toBe(409)
    expect(await json(refused)).toMatchObject({ error: 'logout_failed' })
    expect(await ta.t.db.select().from(accounts).where(eq(accounts.id, a.id))).toHaveLength(1)

    expect((await send(ta.app, `/api/accounts/${a.id}`, { cookie, method: 'DELETE' })).status).toBe(204)
    expect(await ta.t.db.select().from(accounts).where(eq(accounts.id, a.id))).toEqual([])
    expect(await ta.t.db.select().from(codeMessages).where(eq(codeMessages.accountId, a.id))).toEqual([])
    expect(ta.commands.sent.at(-1)).toEqual({ type: 'account.stop', accountId: a.id, logout: false })
  })

  it('lists and ends active sessions only while the account is connected', async () => {
    const a = await insertAccount({ status: 'active' })
    const session = { hash: '-123', current: false, official: true, appName: 'Telegram Desktop', appVersion: '7.2.9 x64', deviceModel: 'Desktop', platform: 'Windows', systemVersion: 'Windows 11 x64', ip: '1.2.3.4', country: 'Kazakhstan', region: '', createdAt: '2026-10-01T00:00:00.000Z', activeAt: '2026-10-03T00:00:00.000Z' }
    ta.commands.respond = (c: WorkerCommand) => (c.type === 'account.sessions' ? { sessions: [session] } : { ok: true })
    expect(await json(await send(ta.app, `/api/accounts/${a.id}/sessions`, { cookie }))).toEqual({ items: [session] })
    expect((await send(ta.app, `/api/accounts/${a.id}/sessions/-123`, { cookie, method: 'DELETE' })).status).toBe(204)
    expect((await send(ta.app, `/api/accounts/${a.id}/sessions/abc`, { cookie, method: 'DELETE' })).status).toBe(400)
    const [read] = await ta.t.db.select().from(auditLog).where(eq(auditLog.action, 'account.sessions.read')).orderBy(desc(auditLog.id)).limit(1)
    expect(read).toMatchObject({ targetId: a.id, result: 'ok' })

    ta.commands.respond = () => ({ error: 'not_running' })
    const offline = await send(ta.app, `/api/accounts/${a.id}/sessions`, { cookie })
    expect(offline.status).toBe(409)
    expect(await json(offline)).toMatchObject({ error: 'not_running' })
  })
})
```

`apps/worker/test/account-manager.test.ts` — изменения

```diff
--- a/apps/worker/test/account-manager.test.ts
+++ b/apps/worker/test/account-manager.test.ts
@@ -152,7 +152,8 @@ describe('account manager', () => {
     await manager.refreshProfiles()
     expect(await read(a.id)).toMatchObject({ username: 'renamed', isPremium: true })
 
-    await manager.stop(a.id, true)
+    expect(await manager.stop(a.id, true)).toEqual({ stopped: true, loggedOut: true })
+    expect(await manager.stop(a.id, true)).toEqual({ stopped: false, loggedOut: false })
     expect(fake.last().loggedOut).toBe(true)
     expect(manager.isRunning(a.id)).toBe(false)
   })
```

- [ ] **Шаг 2: Убедиться, что тест падает**

```bash
fnm exec --using=26 npx vitest run --project api apps/api/test/accounts.test.ts
# FAIL: 404 на /api/accounts
```

- [ ] **Шаг 3: Реализация**

`packages/shared/src/commands.ts` — изменения

```diff
--- a/packages/shared/src/commands.ts
+++ b/packages/shared/src/commands.ts
@@ -1,4 +1,5 @@
 import { z } from 'zod'
+import type { AccountSessionDto } from './accounts.ts'
 
 /** BullMQ queue the api uses to ask the worker to act on accounts and proxies. */
 export const COMMANDS_QUEUE = 'worker-commands'
@@ -18,6 +19,15 @@ export const workerCommandSchema = z.discriminatedUnion('type', [
 export type WorkerCommand = z.output<typeof workerCommandSchema>
 export type WorkerCommandType = WorkerCommand['type']
 
+/** Answers the api reads back (BullMQ job results). */
+export interface AccountStopResult {
+  /** a live client existed and was stopped */
+  stopped: boolean
+  loggedOut: boolean
+}
+export type AccountSessionsResult = { sessions: AccountSessionDto[] } | { error: 'not_running' }
+export type TerminateSessionResult = { ok: true } | { error: 'not_running' }
+
 /** Redis pub/sub channel carrying the 2FA password (or a cancel) to a running QR login; never stored. */
 export const qrControlChannel = (qrId: string) => `accs:qr:${qrId}`
 export const qrControlSchema = z.discriminatedUnion('type', [
```

`packages/db/src/index.ts` — изменения

```diff
--- a/packages/db/src/index.ts
+++ b/packages/db/src/index.ts
@@ -17,4 +17,4 @@ export {
 
 // one drizzle-orm instance for every workspace package: apps import the operators from here, not from drizzle-orm
 // (a second copy — e.g. a peer variant pulled by @mtcute/node's optional sqlite — makes their SQL types incompatible)
-export { and, asc, count, desc, eq, getTableColumns, gt, gte, inArray, isNotNull, isNull, lt, lte, ne, not, notInArray, or, sql, type SQL } from 'drizzle-orm'
+export { and, asc, count, desc, eq, getTableColumns, gt, gte, inArray, isNotNull, isNull, lt, lte, max, ne, not, notInArray, or, sql, type SQL } from 'drizzle-orm'
```

`apps/api/src/app.ts` — изменения

```diff
--- a/apps/api/src/app.ts
+++ b/apps/api/src/app.ts
@@ -10,6 +10,7 @@ import { auditTrail } from './middleware/audit.ts'
 import { requireAuth, sessionLoader } from './middleware/auth.ts'
 import { DomainError } from './lib/errors.ts'
 import { originGuard } from './middleware/origin.ts'
+import { accountRoutes } from './routes/accounts.ts'
 import { adminRoutes } from './routes/admins.ts'
 import { auditRoutes } from './routes/audit.ts'
 import { authRoutes } from './routes/auth.ts'
@@ -67,6 +68,7 @@ export function createApp(deps: AppDeps): Hono<AppEnv> {
   api.route('/', settingsRoutes)
   api.route('/', proxyRoutes)
   api.route('/', importRoutes)
+  api.route('/', accountRoutes)
   api.route('/', codeRoutes)
   api.route('/', auditRoutes)
   api.route('/', eventRoutes)
```

`apps/api/src/routes/accounts.ts` — новый файл

```ts
import { zValidator } from '@hono/zod-validator'
import { deleteAccountQuery, setAccountProxyInput, updateAccountInput } from '@workspace/shared/accounts'
import type { AccountSessionsResult, AccountStopResult, TerminateSessionResult } from '@workspace/shared/commands'
import { Hono } from 'hono'
import { z } from 'zod'
import type { AppEnv } from '../deps.ts'
import { DomainError } from '../lib/errors.ts'
import { audited } from '../middleware/audit.ts'
import { deleteAccountData, getAccount, listAccounts, pauseAccount, resumeAccount, setAccountProxy, updateAccount } from '../services/accounts.ts'
import { validationHook } from './validation.ts'

const idParam = z.object({ id: z.uuid() })
const sessionParam = z.object({ id: z.uuid(), hash: z.string().regex(/^-?\d+$/) })
const NOT_RUNNING = new DomainError(409, 'not_running', 'Аккаунт сейчас не подключён к Telegram')

export const accountRoutes = new Hono<AppEnv>()
  .get('/accounts', async (c) => c.json({ items: await listAccounts(c.get('deps').db) }))
  .get('/accounts/:id', zValidator('param', idParam, validationHook), async (c) => c.json(await getAccount(c.get('deps').db, c.req.valid('param').id)))
  .patch('/accounts/:id', audited('account.update', { target: ['account', 'id'] }), zValidator('param', idParam, validationHook), zValidator('json', updateAccountInput, validationHook), async (c) => {
    const { db, bus } = c.get('deps')
    const account = await updateAccount(db, c.req.valid('param').id, c.req.valid('json'))
    await bus.publish({ type: 'accounts.changed', ids: [account.id] })
    return c.json(account)
  })
  .put('/accounts/:id/proxy', audited('account.proxy', { target: ['account', 'id'] }), zValidator('param', idParam, validationHook), zValidator('json', setAccountProxyInput, validationHook), async (c) => {
    const { db, bus, commands } = c.get('deps')
    const account = await setAccountProxy(db, c.req.valid('param').id, c.req.valid('json').proxyId)
    // reconnect through the new route (or start an account that was waiting for a working proxy)
    await commands.send({ type: 'account.sync', accountId: account.id })
    await bus.publish({ type: 'accounts.changed', ids: [account.id] })
    await bus.publish({ type: 'proxies.changed', ids: [] })
    return c.json(account)
  })
  .post('/accounts/:id/pause', audited('account.pause', { target: ['account', 'id'] }), zValidator('param', idParam, validationHook), async (c) => {
    const { db, bus, commands } = c.get('deps')
    const account = await pauseAccount(db, c.req.valid('param').id)
    await commands.send({ type: 'account.stop', accountId: account.id, logout: false })
    await bus.publish({ type: 'accounts.changed', ids: [account.id] })
    return c.json(account)
  })
  .post('/accounts/:id/resume', audited('account.resume', { target: ['account', 'id'] }), zValidator('param', idParam, validationHook), async (c) => {
    const { db, bus, commands } = c.get('deps')
    const account = await resumeAccount(db, c.req.valid('param').id)
    await commands.send({ type: 'account.sync', accountId: account.id })
    await bus.publish({ type: 'accounts.changed', ids: [account.id] })
    return c.json(account)
  })
  .post('/accounts/:id/reconnect', audited('account.reconnect', { target: ['account', 'id'] }), zValidator('param', idParam, validationHook), async (c) => {
    const { db, commands } = c.get('deps')
    const account = await getAccount(db, c.req.valid('param').id)
    await commands.send({ type: 'account.sync', accountId: account.id })
    return c.body(null, 202)
  })
  .delete('/accounts/:id', audited('account.delete', { target: ['account', 'id'] }), zValidator('param', idParam, validationHook), zValidator('query', deleteAccountQuery, validationHook), async (c) => {
    const { db, bus, commands } = c.get('deps')
    const { id } = c.req.valid('param')
    const { logout } = c.req.valid('query')
    await getAccount(db, id)
    // the worker drops the client first (and ends the Telegram session if asked) — then the data goes
    const result = await commands.call<AccountStopResult>({ type: 'account.stop', accountId: id, logout }, 30_000)
    if (logout && !result.loggedOut) {
      throw new DomainError(409, 'logout_failed', 'Не удалось завершить сессию в Telegram (аккаунт не подключён?) — удалите без выхода')
    }
    await deleteAccountData(db, id)
    await bus.publish({ type: 'accounts.changed', ids: [id] })
    return c.body(null, 204)
  })
  // the list of the owner's devices is sensitive: reading it is audited too
  .get('/accounts/:id/sessions', audited('account.sessions.read', { target: ['account', 'id'] }), zValidator('param', idParam, validationHook), async (c) => {
    const result = await c.get('deps').commands.call<AccountSessionsResult>({ type: 'account.sessions', accountId: c.req.valid('param').id })
    if ('error' in result) throw NOT_RUNNING
    return c.json({ items: result.sessions })
  })
  .delete('/accounts/:id/sessions/:hash', audited('account.session.terminate', { target: ['account', 'id'] }), zValidator('param', sessionParam, validationHook), async (c) => {
    const { id, hash } = c.req.valid('param')
    const result = await c.get('deps').commands.call<TerminateSessionResult>({ type: 'account.terminateSession', accountId: id, hash })
    if ('error' in result) throw NOT_RUNNING
    return c.body(null, 204)
  })
```

`apps/api/src/services/accounts.ts` — новый файл

```ts
import { accounts, and, codeMessages, eq, inArray, isNull, max, ne, proxies, sql, type Db } from '@workspace/db'
import type { AccountDto, UpdateAccountInput } from '@workspace/shared/accounts'
import { DomainError } from '../lib/errors.ts'

type AccountRow = typeof accounts.$inferSelect
type ProxyRef = NonNullable<AccountDto['proxy']>

const iso = (d: Date | null) => (d ? d.toISOString() : null)

function toAccountDto(row: AccountRow, proxy: ProxyRef | null, lastCodeAt: Date | null): AccountDto {
  return {
    id: row.id,
    tgUserId: row.tgUserId,
    phone: row.phone,
    username: row.username,
    firstName: row.firstName,
    lastName: row.lastName,
    isPremium: row.isPremium,
    dcId: row.dcId,
    label: row.label,
    note: row.note,
    source: row.source,
    clientProfile: row.clientProfile,
    device: row.device,
    connectionMode: row.connectionMode,
    proxy,
    status: row.status,
    statusReason: row.statusReason,
    statusChangedAt: row.statusChangedAt.toISOString(),
    lastOkAt: iso(row.lastOkAt),
    frozenUntil: iso(row.frozenUntil),
    lastCodeAt: iso(lastCodeAt),
    createdAt: row.createdAt.toISOString(),
  }
}

function selectAccounts(db: Db) {
  const lastCodes = db.select({ accountId: codeMessages.accountId, last: max(codeMessages.date).as('last') }).from(codeMessages).groupBy(codeMessages.accountId).as('last_codes')
  return db
    .select({
      account: accounts,
      proxy: { id: proxies.id, type: proxies.type, host: proxies.host, port: proxies.port, status: proxies.status, tgCountry: proxies.tgCountry },
      lastCodeAt: lastCodes.last,
    })
    .from(accounts)
    .leftJoin(proxies, eq(proxies.id, accounts.proxyId))
    .leftJoin(lastCodes, eq(lastCodes.accountId, accounts.id))
}

type Selected = Awaited<ReturnType<ReturnType<typeof selectAccounts>['execute']>>[number]
// an aggregate in a subquery may come back as a string or a Date depending on the driver path
const asDate = (v: unknown) => (v instanceof Date ? v : v ? new Date(String(v)) : null)
const fromRow = (r: Selected) => toAccountDto(r.account, r.proxy?.id ? (r.proxy as ProxyRef) : null, asDate(r.lastCodeAt))

export async function listAccounts(db: Db): Promise<AccountDto[]> {
  return (await selectAccounts(db).orderBy(accounts.createdAt)).map(fromRow)
}

export async function getAccount(db: Db, id: string): Promise<AccountDto> {
  const [row] = await selectAccounts(db).where(eq(accounts.id, id))
  if (!row) throw new DomainError(404, 'not_found', 'Аккаунт не найден')
  return fromRow(row)
}

export async function updateAccount(db: Db, id: string, input: UpdateAccountInput): Promise<AccountDto> {
  const set: Partial<typeof accounts.$inferInsert> = {}
  if (input.label !== undefined) set.label = input.label || null
  if (input.note !== undefined) set.note = input.note || null
  if (Object.keys(set).length > 0) await db.update(accounts).set(set).where(eq(accounts.id, id))
  return getAccount(db, id)
}

/**
 * Binds a free proxy (or none: `direct`, only by an explicit decision). A free proxy is enabled, not
 * dead/expired/provisioning and not used by another account.
 */
export async function setAccountProxy(db: Db, id: string, proxyId: string | null): Promise<AccountDto> {
  const account = await getAccount(db, id)
  if (proxyId) {
    const [proxy] = await db
      .select({ id: proxies.id })
      .from(proxies)
      .leftJoin(accounts, and(eq(accounts.proxyId, proxies.id), ne(accounts.id, id)))
      .where(and(eq(proxies.id, proxyId), isNull(proxies.disabledAt), inArray(proxies.status, ['ok', 'unchecked', 'failing']), isNull(accounts.id)))
    if (!proxy) throw new DomainError(409, 'proxy_unavailable', 'Прокси не работает, отключён или уже занят другим аккаунтом')
  }
  await db
    .update(accounts)
    .set({
      proxyId,
      connectionMode: proxyId ? 'proxy' : 'direct',
      // an account stopped because of its old proxy gets another chance with the new one
      ...(account.status === 'proxy_down' ? { status: 'pending_check' as const, statusReason: null, statusChangedAt: new Date() } : {}),
    })
    .where(eq(accounts.id, id))
  return getAccount(db, id)
}

const PAUSABLE = ['pending_check', 'active', 'proxy_down', 'frozen', 'error'] as const

export async function pauseAccount(db: Db, id: string): Promise<AccountDto> {
  const account = await getAccount(db, id)
  if (!(PAUSABLE as readonly string[]).includes(account.status)) throw new DomainError(409, 'not_pausable', 'Этот аккаунт нельзя поставить на паузу')
  await db.update(accounts).set({ status: 'paused', statusReason: null, statusChangedAt: new Date() }).where(eq(accounts.id, id))
  return getAccount(db, id)
}

export async function resumeAccount(db: Db, id: string): Promise<AccountDto> {
  const account = await getAccount(db, id)
  if (account.status !== 'paused') throw new DomainError(409, 'not_paused', 'Аккаунт не на паузе')
  await db.update(accounts).set({ status: 'pending_check', statusReason: null, statusChangedAt: new Date() }).where(eq(accounts.id, id))
  return getAccount(db, id)
}

/** The account row (auth keys and codes go with it) and everything mtcute kept for it. */
export async function deleteAccountData(db: Db, id: string): Promise<void> {
  await db.delete(accounts).where(eq(accounts.id, id))
  for (const table of ['key_value', 'auth_keys', 'temp_auth_keys', 'peers', 'message_refs']) {
    await db.execute(sql`delete from ${sql.identifier('mtcute')}.${sql.identifier(table)} where account = ${id}`).catch((err: { code?: string; cause?: { code?: string } }) => {
      // 42P01: mtcute's tables do not exist yet (the worker never ran)
      if ((err.cause?.code ?? err.code) !== '42P01') throw err
    })
  }
}
```

`apps/worker/src/accounts/manager.ts` — изменения

```diff
--- a/apps/worker/src/accounts/manager.ts
+++ b/apps/worker/src/accounts/manager.ts
@@ -28,7 +28,8 @@ export interface AccountManager {
   startAll(): Promise<void>
   /** reload one account from the database and run it if its status says so */
   sync(accountId: string): Promise<void>
-  stop(accountId: string, logout?: boolean): Promise<void>
+  /** whether a live client was stopped, and whether it logged out first */
+  stop(accountId: string, logout?: boolean): Promise<{ stopped: boolean; loggedOut: boolean }>
   onProxyDown(proxyId: string): Promise<void>
   onProxyUp(proxyId: string): Promise<void>
   onProxyChanged(proxyId: string): Promise<void>
@@ -111,12 +112,22 @@ export function createAccountManager(deps: WorkerDeps, factory: SessionFactory,
     retries.set(id, { attempt, timer })
   }
 
-  async function stopSession(id: string, logout = false): Promise<void> {
+  async function stopSession(id: string, logout = false): Promise<{ stopped: boolean; loggedOut: boolean }> {
     const session = running.get(id)
-    if (!session) return
+    if (!session) return { stopped: false, loggedOut: false }
     running.delete(id)
-    if (logout) await session.logOut().catch((err: unknown) => logger.warn({ err, accountId: id }, 'accounts: log out failed'))
+    let loggedOut = false
+    if (logout) {
+      loggedOut = await session
+        .logOut()
+        .then(() => true)
+        .catch((err: unknown) => {
+          logger.warn({ err, accountId: id }, 'accounts: log out failed')
+          return false
+        })
+    }
     await session.stop().catch((err: unknown) => logger.warn({ err, accountId: id }, 'accounts: stop failed'))
+    return { stopped: true, loggedOut }
   }
 
   async function handleError(id: string, err: unknown): Promise<void> {
@@ -232,7 +243,7 @@ export function createAccountManager(deps: WorkerDeps, factory: SessionFactory,
     },
     async stop(accountId, logout = false) {
       clearRetry(accountId)
-      await stopSession(accountId, logout)
+      return stopSession(accountId, logout)
     },
     async onProxyDown(proxyId) {
       for (const account of await accountsOnProxy(proxyId)) {
```

`apps/worker/src/main.ts` — изменения

```diff
--- a/apps/worker/src/main.ts
+++ b/apps/worker/src/main.ts
@@ -7,7 +7,7 @@ import { acquireSingletonLock } from './lock.ts'
 import { createMtcuteProxyChecker } from './proxies/checker.ts'
 import { createProxyHealth } from './proxies/health.ts'
 import { syncProxyStore } from './proxies/proxy-store.ts'
-import { createAccountManager, type SessionFactory } from './accounts/manager.ts'
+import { AccountNotRunningError, createAccountManager, type SessionFactory } from './accounts/manager.ts'
 import { createCodeCollector } from './codes/collector.ts'
 import { housekeeping } from './housekeeping.ts'
 import { createNotifier } from './notify/notifier.ts'
@@ -70,8 +70,23 @@ const runtime = createWorkerRuntime(deps, {
     'proxy.sync': async () => syncProxyStore(deps, fetch, proxyStoreHooks),
     'account.sync': async ({ accountId }) => accountManager.sync(accountId),
     'account.stop': async ({ accountId, logout }) => accountManager.stop(accountId, logout),
-    'account.sessions': async ({ accountId }) => accountManager.sessions(accountId),
-    'account.terminateSession': async ({ accountId, hash }) => accountManager.terminateSession(accountId, hash),
+    'account.sessions': async ({ accountId }) => {
+      try {
+        return { sessions: await accountManager.sessions(accountId) }
+      } catch (err) {
+        if (err instanceof AccountNotRunningError) return { error: 'not_running' }
+        throw err
+      }
+    },
+    'account.terminateSession': async ({ accountId, hash }) => {
+      try {
+        await accountManager.terminateSession(accountId, hash)
+        return { ok: true }
+      } catch (err) {
+        if (err instanceof AccountNotRunningError) return { error: 'not_running' }
+        throw err
+      }
+    },
   },
   maintenance: {
     'proxies.checkDue': async () => {
```

- [ ] **Шаг 4: Проверки**

```bash
fnm exec --using=26 pnpm typecheck
fnm exec --using=26 pnpm lint
fnm exec --using=26 npx vitest run --project api --project worker
# всё зелёное
```

- [ ] **Шаг 5: Коммит**

```bash
git add -A
git commit -F - <<'MSG'
feat(api): accounts — list with proxy and last code, label/note, proxy or direct, pause/resume/reconnect, delete with optional Telegram logout, active sessions (audited read) and terminate
MSG
```

---

### Task 15: Вход по QR

API: `POST /qr` (нужны `telegram.own.apiId`/`apiHash`, прокси должен быть свободен) ставит воркеру `qr.start`; `POST /qr/:id/password` и `DELETE /qr/:id` публикуют в Redis-канал `accs:qr:<id>` — пароль 2FA не хранится, не логируется и не пишется в аудит. Воркер: временный клиент в `MemoryStorage` (ключ не попадает в БД, пока нет аккаунта), события `qr.update` (`waiting` с URL и сроком, `scanned`, `password_needed` / `password_invalid` с подсказкой, `done`, `failed`, `expired`, `cancelled`), общий таймаут `telegram.qrTimeout`. Аккаунт уже в панели → новая сессия выходит, `failed`. Успех → аккаунт `source=qr`, `client_profile=own`, session string в `session_import_enc` → `account.sync`.

**Files:**
- Modify: `apps/api/src/app.ts`
- Create: `apps/api/src/routes/qr.ts`
- Modify: `apps/api/src/services/accounts.ts`
- Test: `apps/api/test/qr.test.ts`
- Modify: `apps/worker/src/main.ts`
- Create: `apps/worker/src/qr/client.ts`
- Create: `apps/worker/src/qr/login.ts`
- Test: `apps/worker/test/qr-login.test.ts`

**Interfaces:**
- Consumes: `qrControlChannel`, `QR_STATES` (задача 2); менеджер аккаунтов (задача 11); `isProxyFree` (задача 14).
- Produces:
  - `apps/api/src/routes/qr.ts`: `qrRoutes`
  - `apps/api/src/services/accounts.ts`: `isProxyFree(db: Db, proxyId: string, exceptAccountId?: string): Promise<boolean>`
  - `apps/worker/src/qr/client.ts`: `interface QrSignInParams`; `interface QrClient`; `type QrClientFactory`; `createMtcuteQrClient: QrClientFactory`
  - `apps/worker/src/qr/login.ts`: `interface QrStart`; `interface QrLoginOptions`; `createQrLogin(deps: WorkerDeps, factory: QrClientFactory, options: QrLoginOptions = {})`

- [ ] **Шаг 1: Написать падающий тест**

`apps/api/test/qr.test.ts` — новый файл

```ts
import { auditLog, desc, eq } from '@workspace/db'
import { createRedis } from '@workspace/server'
import { qrControlChannel } from '@workspace/shared/commands'
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest'
import { loginAs, send, setupApp, type TestApp } from './helpers.ts'

let ta: TestApp
let cookie: string
beforeAll(async () => {
  ta = await setupApp()
  cookie = (await loginAs(ta)).cookie
})
afterAll(async () => {
  await ta.close()
})

describe('QR login api', () => {
  it('needs the own api_id before starting', async () => {
    const res = await send(ta.app, '/api/qr', { cookie, body: { proxyId: null } })
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ error: 'own_api_missing' })
  })

  it('starts a login on the worker, forwards the 2FA password and the cancel over pub/sub', async () => {
    await ta.deps.settings.update({ 'telegram.own.apiId': 123456, 'telegram.own.apiHash': '0123456789abcdef0123456789abcdef' }, { adminId: null })
    ta.commands.sent = []
    const { qrId } = (await (await send(ta.app, '/api/qr', { cookie, body: { proxyId: null } })).json()) as { qrId: string }
    expect(ta.commands.sent).toEqual([{ type: 'qr.start', qrId, proxyId: null, adminId: expect.any(String) }])

    const sub = createRedis(inject('redisUrl'), 'qr-test-sub')
    const received: string[] = []
    try {
      await sub.subscribe(qrControlChannel(qrId))
      sub.on('message', (_c: string, m: string) => received.push(m))
      expect((await send(ta.app, `/api/qr/${qrId}/password`, { cookie, body: { password: 'my-2fa-pass' } })).status).toBe(202)
      expect((await send(ta.app, `/api/qr/${qrId}`, { cookie, method: 'DELETE' })).status).toBe(204)
      await vi.waitFor(() => expect(received.map((m) => JSON.parse(m))).toEqual([{ type: 'password', password: 'my-2fa-pass' }, { type: 'cancel' }]))
    } finally {
      await sub.quit()
    }
    const [audit] = await ta.t.db.select().from(auditLog).where(eq(auditLog.action, 'account.qr.password')).orderBy(desc(auditLog.id)).limit(1)
    expect(audit).toMatchObject({ targetId: qrId, payload: null })
  })
})
```

`apps/worker/test/qr-login.test.ts` — новый файл

```ts
import { randomUUID } from 'node:crypto'
import { accounts, eq } from '@workspace/db'
import type { AppEvent } from '@workspace/shared/events'
import { qrControlChannel } from '@workspace/shared/commands'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { QrClient, QrClientFactory, QrSignInParams } from '../src/qr/client.ts'
import { createQrLogin } from '../src/qr/login.ts'
import { setupWorker, type TestWorker } from './helpers.ts'

let w: TestWorker
beforeAll(async () => {
  w = await setupWorker()
  await w.deps.settings.update({ 'telegram.own.apiId': 123456, 'telegram.own.apiHash': '0123456789abcdef0123456789abcdef' }, { adminId: null })
})
afterAll(async () => {
  await w.close()
})
beforeEach(async () => {
  await w.t.db.delete(accounts)
})

/** Scripted login: shows a QR, gets scanned, asks for 2FA (wrong once), succeeds as `userId`. */
function scriptedFactory(userId: number, opts: { twoFa?: boolean; hang?: boolean } = {}) {
  const made: (QrClient & { loggedOut: boolean; destroyed: boolean })[] = []
  const factory: QrClientFactory = () => {
    const client = {
      loggedOut: false,
      destroyed: false,
      async signIn(p: QrSignInParams) {
        p.onUrlUpdated('tg://login?token=abc', new Date(Date.now() + 30_000))
        if (opts.hang) {
          await new Promise((_, reject) => p.abortSignal.addEventListener('abort', () => reject(p.abortSignal.reason), { once: true }))
        }
        p.onQrScanned()
        if (opts.twoFa) {
          if ((await p.password()) !== 'right') {
            p.invalidPasswordCallback()
            if ((await p.password()) !== 'right') throw new Error('PASSWORD_HASH_INVALID')
          }
        }
        return { tgUserId: userId, phone: '77009998877', username: 'qr_user', firstName: 'QR', lastName: null, isPremium: false, dcId: 2 }
      },
      passwordHint: async () => 'кличка кота',
      exportSession: async () => 'exported-session',
      async logOut() {
        client.loggedOut = true
      },
      async destroy() {
        client.destroyed = true
      },
    }
    made.push(client)
    return client
  }
  return { factory, made }
}

async function collect(qrId: string) {
  const states: AppEvent[] = []
  const off = w.deps.bus.subscribe((e) => {
    if (e.type === 'qr.update' && e.qrId === qrId) states.push(e)
  })
  return { states, off }
}
const sendControl = (qrId: string, message: unknown) => w.deps.redis.publish(qrControlChannel(qrId), JSON.stringify(message))

describe('QR login', () => {
  it('walks through QR, scan and 2FA, then saves the account with its session and starts it', async () => {
    const qrId = randomUUID()
    const { factory, made } = scriptedFactory(31337, { twoFa: true })
    const onAccountCreated = vi.fn()
    const { states, off } = await collect(qrId)
    const login = createQrLogin(w.deps, factory, { onAccountCreated })
    const run = login.run({ qrId, proxyId: null, adminId: null })
    await vi.waitFor(() => expect(states.map((s) => (s as { state: string }).state)).toContain('password_needed'))
    await sendControl(qrId, { type: 'password', password: 'wrong' })
    await vi.waitFor(() => expect(states.map((s) => (s as { state: string }).state)).toContain('password_invalid'))
    await sendControl(qrId, { type: 'password', password: 'right' })
    await run
    // events travel through Redis pub/sub: wait for the last one before looking
    await vi.waitFor(() => expect(states.at(-1)).toMatchObject({ state: 'done' }))
    off()

    const [account] = await w.t.db.select().from(accounts).where(eq(accounts.tgUserId, 31337))
    expect(account).toMatchObject({ source: 'qr', clientProfile: 'own', connectionMode: 'direct', status: 'pending_check', phone: '77009998877' })
    expect(w.deps.cipher.decrypt(account!.sessionImportEnc!)).toBe('exported-session')
    expect(onAccountCreated).toHaveBeenCalledWith(account!.id)
    expect(states.map((s) => (s as { state: string }).state)).toEqual(['waiting', 'scanned', 'password_needed', 'password_invalid', 'password_needed', 'done'])
    expect(states[0]).toMatchObject({ url: 'tg://login?token=abc' })
    expect(states[2]).toMatchObject({ hint: 'кличка кота' })
    expect(made[0]!.destroyed).toBe(true)
  })

  it('logs the new session out when the account is already in the panel', async () => {
    const device = { deviceModel: 'Desktop', systemVersion: 'Windows 11 x64', appVersion: '7.2.9 x64', langCode: 'ru' }
    const [existing] = await w.t.db.insert(accounts).values({ tgUserId: 4242, source: 'tdata', clientProfile: 'desktop', device, connectionMode: 'direct' }).returning()
    const qrId = randomUUID()
    const { factory, made } = scriptedFactory(4242)
    const { states, off } = await collect(qrId)
    await createQrLogin(w.deps, factory).run({ qrId, proxyId: null, adminId: null })
    await vi.waitFor(() => expect(states.at(-1)).toMatchObject({ state: 'failed', accountId: existing!.id, message: 'Этот аккаунт уже есть в панели' }))
    off()
    expect(made[0]!.loggedOut).toBe(true)
    expect(await w.t.db.select().from(accounts)).toHaveLength(1)
  })

  it('stops on cancel and on timeout', async () => {
    const cancelId = randomUUID()
    const cancelled = await collect(cancelId)
    const running = createQrLogin(w.deps, scriptedFactory(1, { hang: true }).factory).run({ qrId: cancelId, proxyId: null, adminId: null })
    await vi.waitFor(() => expect(cancelled.states).toHaveLength(1))
    await sendControl(cancelId, { type: 'cancel' })
    await running
    await vi.waitFor(() => expect(cancelled.states.at(-1)).toMatchObject({ state: 'cancelled' }))
    cancelled.off()

    const timeoutId = randomUUID()
    const expired = await collect(timeoutId)
    await createQrLogin(w.deps, scriptedFactory(2, { hang: true }).factory, { timeoutMs: 100 }).run({ qrId: timeoutId, proxyId: null, adminId: null })
    await vi.waitFor(() => expect(expired.states.at(-1)).toMatchObject({ state: 'expired' }))
    expired.off()
  })

  it('refuses to start without the own api_id', async () => {
    await w.deps.settings.update({ 'telegram.own.apiId': null }, { adminId: null })
    const qrId = randomUUID()
    const { states, off } = await collect(qrId)
    await createQrLogin(w.deps, scriptedFactory(1).factory).run({ qrId, proxyId: null, adminId: null })
    await vi.waitFor(() => expect(states).toEqual([expect.objectContaining({ state: 'failed', message: 'Не задан свой api_id / api_hash (Настройки → Telegram)' })]))
    off()
    await w.deps.settings.update({ 'telegram.own.apiId': 123456 }, { adminId: null })
  })
})
```

- [ ] **Шаг 2: Убедиться, что тест падает**

```bash
fnm exec --using=26 npx vitest run --project worker apps/worker/test/qr-login.test.ts && fnm exec --using=26 npx vitest run --project api apps/api/test/qr.test.ts
# FAIL: Cannot find module '../src/qr/login.ts'
```

- [ ] **Шаг 3: Реализация**

`apps/api/src/app.ts` — изменения

```diff
--- a/apps/api/src/app.ts
+++ b/apps/api/src/app.ts
@@ -19,6 +19,7 @@ import { eventRoutes } from './routes/events.ts'
 import { healthRoutes } from './routes/health.ts'
 import { importRoutes } from './routes/imports.ts'
 import { proxyRoutes } from './routes/proxies.ts'
+import { qrRoutes } from './routes/qr.ts'
 import { settingsRoutes } from './routes/settings.ts'
 import { WorkerTimeoutError } from '@workspace/server'
 import { AdminError } from './services/admins.ts'
@@ -69,6 +70,7 @@ export function createApp(deps: AppDeps): Hono<AppEnv> {
   api.route('/', proxyRoutes)
   api.route('/', importRoutes)
   api.route('/', accountRoutes)
+  api.route('/', qrRoutes)
   api.route('/', codeRoutes)
   api.route('/', auditRoutes)
   api.route('/', eventRoutes)
```

`apps/api/src/routes/qr.ts` — новый файл

```ts
import { randomUUID } from 'node:crypto'
import { zValidator } from '@hono/zod-validator'
import { qrPasswordInput, startQrInput } from '@workspace/shared/accounts'
import { qrControlChannel, type QrControl } from '@workspace/shared/commands'
import { Hono } from 'hono'
import { z } from 'zod'
import type { AppEnv } from '../deps.ts'
import { DomainError } from '../lib/errors.ts'
import { audited } from '../middleware/audit.ts'
import { isProxyFree } from '../services/accounts.ts'
import { validationHook } from './validation.ts'

const idParam = z.object({ id: z.uuid() })

/** Progress comes back as `qr.update` events on the live stream. */
export const qrRoutes = new Hono<AppEnv>()
  .post('/qr', audited('account.qr.start'), zValidator('json', startQrInput, validationHook), async (c) => {
    const { settings, db, commands } = c.get('deps')
    if (!settings.get('telegram.own.apiId') || !settings.get('telegram.own.apiHash')) {
      throw new DomainError(409, 'own_api_missing', 'Для входа по QR нужен свой api_id и api_hash (Настройки → Telegram)')
    }
    const { proxyId } = c.req.valid('json')
    if (proxyId && !(await isProxyFree(db, proxyId))) throw new DomainError(409, 'proxy_unavailable', 'Прокси не работает, отключён или уже занят')
    const qrId = randomUUID()
    await commands.send({ type: 'qr.start', qrId, proxyId, adminId: c.get('admin')?.id ?? null })
    c.set('audit', { ...c.get('audit'), targetType: 'qr', targetId: qrId })
    return c.json({ qrId }, 201)
  })
  // the 2FA password goes straight to the worker over pub/sub: not stored, not in the audit log
  .post('/qr/:id/password', audited('account.qr.password', { payload: null, target: ['qr', 'id'] }), zValidator('param', idParam, validationHook), zValidator('json', qrPasswordInput, validationHook), async (c) => {
    const message: QrControl = { type: 'password', password: c.req.valid('json').password }
    await c.get('deps').redis.publish(qrControlChannel(c.req.valid('param').id), JSON.stringify(message))
    return c.body(null, 202)
  })
  .delete('/qr/:id', audited('account.qr.cancel', { target: ['qr', 'id'] }), zValidator('param', idParam, validationHook), async (c) => {
    const message: QrControl = { type: 'cancel' }
    await c.get('deps').redis.publish(qrControlChannel(c.req.valid('param').id), JSON.stringify(message))
    return c.body(null, 204)
  })
```

`apps/api/src/services/accounts.ts` — изменения

```diff
--- a/apps/api/src/services/accounts.ts
+++ b/apps/api/src/services/accounts.ts
@@ -70,19 +70,24 @@ export async function updateAccount(db: Db, id: string, input: UpdateAccountInpu
   return getAccount(db, id)
 }
 
+/** Enabled, working (or not yet checked) and not used by another account. */
+export async function isProxyFree(db: Db, proxyId: string, exceptAccountId?: string): Promise<boolean> {
+  const [proxy] = await db
+    .select({ id: proxies.id })
+    .from(proxies)
+    .leftJoin(accounts, exceptAccountId ? and(eq(accounts.proxyId, proxies.id), ne(accounts.id, exceptAccountId)) : eq(accounts.proxyId, proxies.id))
+    .where(and(eq(proxies.id, proxyId), isNull(proxies.disabledAt), inArray(proxies.status, ['ok', 'unchecked', 'failing']), isNull(accounts.id)))
+  return Boolean(proxy)
+}
+
 /**
  * Binds a free proxy (or none: `direct`, only by an explicit decision). A free proxy is enabled, not
  * dead/expired/provisioning and not used by another account.
  */
 export async function setAccountProxy(db: Db, id: string, proxyId: string | null): Promise<AccountDto> {
   const account = await getAccount(db, id)
-  if (proxyId) {
-    const [proxy] = await db
-      .select({ id: proxies.id })
-      .from(proxies)
-      .leftJoin(accounts, and(eq(accounts.proxyId, proxies.id), ne(accounts.id, id)))
-      .where(and(eq(proxies.id, proxyId), isNull(proxies.disabledAt), inArray(proxies.status, ['ok', 'unchecked', 'failing']), isNull(accounts.id)))
-    if (!proxy) throw new DomainError(409, 'proxy_unavailable', 'Прокси не работает, отключён или уже занят другим аккаунтом')
+  if (proxyId && !(await isProxyFree(db, proxyId, id))) {
+    throw new DomainError(409, 'proxy_unavailable', 'Прокси не работает, отключён или уже занят другим аккаунтом')
   }
   await db
     .update(accounts)
```

`apps/worker/src/main.ts` — изменения

```diff
--- a/apps/worker/src/main.ts
+++ b/apps/worker/src/main.ts
@@ -11,6 +11,8 @@ import { AccountNotRunningError, createAccountManager, type SessionFactory } fro
 import { createCodeCollector } from './codes/collector.ts'
 import { housekeeping } from './housekeeping.ts'
 import { createNotifier } from './notify/notifier.ts'
+import { createMtcuteQrClient } from './qr/client.ts'
+import { createQrLogin } from './qr/login.ts'
 import { createMtcuteSession } from './telegram/mtcute-session.ts'
 import { createAccountStorage, prepareMtcuteStorage } from './telegram/storage.ts'
 import { createWorkerRuntime } from './runtime.ts'
@@ -60,6 +62,8 @@ const notifier = createNotifier(deps, fetch)
 const codeCollector = createCodeCollector(deps, { onCode: notifier.onCode })
 const accountManager = createAccountManager(deps, sessionFactory, { onSessionStarted: codeCollector.attach, onStatusChanged: notifier.onStatusChanged })
 
+const qrLogin = createQrLogin(deps, createMtcuteQrClient, { onAccountCreated: accountManager.sync })
+
 const proxyChecker = createMtcuteProxyChecker(() => ({ apiId: settings.get('telegram.desktop.apiId'), apiHash: settings.get('telegram.desktop.apiHash') }))
 const proxyHealth = createProxyHealth(deps, proxyChecker, { onDown: accountManager.onProxyDown, onUp: accountManager.onProxyUp })
 const proxyStoreHooks = { onChanged: accountManager.onProxyChanged, onDown: accountManager.onProxyDown }
@@ -69,6 +73,7 @@ const runtime = createWorkerRuntime(deps, {
     'proxy.check': async ({ proxyId }) => proxyHealth.checkById(proxyId),
     'proxy.sync': async () => syncProxyStore(deps, fetch, proxyStoreHooks),
     'account.sync': async ({ accountId }) => accountManager.sync(accountId),
+    'qr.start': async (start) => qrLogin.run(start),
     'account.stop': async ({ accountId, logout }) => accountManager.stop(accountId, logout),
     'account.sessions': async ({ accountId }) => {
       try {
```

`apps/worker/src/qr/client.ts` — новый файл

```ts
import { MemoryStorage, TelegramClient } from '@mtcute/node'
import type { AccountDevice } from '@workspace/db'
import { proxyTransport, type ProxyEndpoint } from '../proxies/checker.ts'
import type { SessionProfile } from '../telegram/session.ts'

export interface QrSignInParams {
  onUrlUpdated: (url: string, expires: Date) => void
  onQrScanned: () => void
  /** called when the account has 2FA; resolves with the password the admin typed */
  password: () => Promise<string>
  invalidPasswordCallback: () => void
  abortSignal: AbortSignal
}

/** A throwaway client for one QR login; its session is exported and handed to the account manager. */
export interface QrClient {
  signIn(params: QrSignInParams): Promise<SessionProfile>
  passwordHint(): Promise<string | null>
  exportSession(): Promise<string>
  logOut(): Promise<void>
  destroy(): Promise<void>
}

export type QrClientFactory = (options: { apiId: number; apiHash: string; device: AccountDevice; proxy: ProxyEndpoint | null }) => QrClient

export const createMtcuteQrClient: QrClientFactory = (options) => {
  const client = new TelegramClient({
    apiId: options.apiId,
    apiHash: options.apiHash,
    // in memory: the account row does not exist until the login succeeds
    storage: new MemoryStorage(),
    ...(options.proxy ? { transport: proxyTransport(options.proxy) } : {}),
    initConnectionOptions: {
      deviceModel: options.device.deviceModel,
      systemVersion: options.device.systemVersion,
      appVersion: options.device.appVersion,
      langCode: options.device.langCode,
      systemLangCode: options.device.langCode,
    },
    logLevel: 1,
  })
  return {
    async signIn(params) {
      const user = await client.signInQr({
        onUrlUpdated: params.onUrlUpdated,
        onQrScanned: params.onQrScanned,
        password: params.password,
        invalidPasswordCallback: params.invalidPasswordCallback,
        abortSignal: params.abortSignal,
      })
      return {
        tgUserId: user.id,
        phone: user.phoneNumber ?? null,
        username: user.username ?? null,
        firstName: user.firstName || null,
        lastName: user.lastName ?? null,
        isPremium: user.isPremium,
        dcId: user.dcId ?? null,
      }
    },
    async passwordHint() {
      const pwd = await client.call({ _: 'account.getPassword' })
      return pwd.hint ?? null
    },
    exportSession: () => client.exportSession(),
    async logOut() {
      await client.logOut()
    },
    destroy: () => client.destroy(),
  }
}
```

`apps/worker/src/qr/login.ts` — новый файл

```ts
import { accounts, and, eq, isNull, proxies } from '@workspace/db'
import { writeAudit, type Redis } from '@workspace/server'
import type { QrState } from '@workspace/shared/accounts'
import { qrControlChannel, qrControlSchema, type QrControl } from '@workspace/shared/commands'
import { parseDuration } from '@workspace/shared/duration'
import type { WorkerDeps } from '../deps.ts'
import type { ProxyEndpoint } from '../proxies/checker.ts'
import type { QrClientFactory } from './client.ts'

export interface QrStart {
  qrId: string
  proxyId: string | null
  adminId: string | null
}

export interface QrLoginOptions {
  /** overrides telegram.qrTimeout (tests) */
  timeoutMs?: number
  /** the new account is in the database: start it */
  onAccountCreated?: (accountId: string) => Promise<void> | void
}

/**
 * Runs one QR login: publishes the QR link and progress as `qr.update` events, takes the 2FA password from a
 * Redis channel (never stored), and on success saves the account with its session for the account manager.
 */
export function createQrLogin(deps: WorkerDeps, factory: QrClientFactory, options: QrLoginOptions = {}) {
  const { db, settings, bus, logger, cipher } = deps

  const update = (qrId: string, state: QrState, extra: { url?: string; expiresAt?: string; hint?: string; accountId?: string; message?: string } = {}) =>
    bus.publish({ type: 'qr.update', qrId, state, ...extra })

  async function proxyEndpoint(proxyId: string | null): Promise<ProxyEndpoint | null> {
    if (!proxyId) return null
    const [proxy] = await db
      .select()
      .from(proxies)
      .leftJoin(accounts, eq(accounts.proxyId, proxies.id))
      .where(and(eq(proxies.id, proxyId), isNull(proxies.disabledAt), isNull(accounts.id)))
    if (!proxy || !['ok', 'unchecked', 'failing'].includes(proxy.proxies.status)) throw new Error('Прокси недоступен или уже занят')
    const p = proxy.proxies
    return { type: p.type, host: p.host, port: p.port, username: p.username, password: p.passwordEnc ? cipher.decrypt(p.passwordEnc) : null }
  }

  /** A private subscriber connection per login: the password and cancel arrive on the login's own channel. */
  async function control(redis: Redis, qrId: string, onMessage: (message: QrControl) => void): Promise<() => Promise<void>> {
    const sub = redis.duplicate()
    await sub.subscribe(qrControlChannel(qrId))
    sub.on('message', (_channel: string, raw: string) => {
      try {
        onMessage(qrControlSchema.parse(JSON.parse(raw)))
      } catch {
        // malformed control message: ignore
      }
    })
    return async () => {
      await sub.quit().catch(() => {})
    }
  }

  return {
    async run({ qrId, proxyId, adminId }: QrStart): Promise<void> {
      const apiId = settings.get('telegram.own.apiId')
      const apiHash = settings.get('telegram.own.apiHash')
      if (!apiId || !apiHash) {
        await update(qrId, 'failed', { message: 'Не задан свой api_id / api_hash (Настройки → Telegram)' })
        return
      }
      const abort = new AbortController()
      const timeoutMs = options.timeoutMs ?? parseDuration(settings.get('telegram.qrTimeout'))
      const timer = setTimeout(() => abort.abort(new Error('expired')), timeoutMs)
      let passwordWaiter: ((password: string) => void) | null = null
      const stopControl = await control(deps.redis, qrId, (message) => {
        if (message.type === 'cancel') abort.abort(new Error('cancelled'))
        if (message.type === 'password' && passwordWaiter) {
          passwordWaiter(message.password)
          passwordWaiter = null
        }
      })

      let client: ReturnType<QrClientFactory> | undefined
      try {
        const proxy = await proxyEndpoint(proxyId)
        const device = {
          deviceModel: settings.get('telegram.desktop.deviceModel'),
          systemVersion: settings.get('telegram.desktop.systemVersion'),
          appVersion: settings.get('telegram.desktop.appVersion'),
          langCode: settings.get('telegram.desktop.langCode'),
        }
        client = factory({ apiId, apiHash, device, proxy })
        const qrClient = client
        const profile = await qrClient.signIn({
          abortSignal: abort.signal,
          onUrlUpdated: (url, expires) => void update(qrId, 'waiting', { url, expiresAt: expires.toISOString() }),
          onQrScanned: () => void update(qrId, 'scanned'),
          password: async () => {
            const hint = await qrClient.passwordHint().catch(() => null)
            await update(qrId, 'password_needed', hint ? { hint } : {})
            return new Promise<string>((resolve, reject) => {
              passwordWaiter = resolve
              abort.signal.addEventListener('abort', () => reject(abort.signal.reason), { once: true })
            })
          },
          invalidPasswordCallback: () => void update(qrId, 'password_invalid'),
        })

        const [existing] = await db.select({ id: accounts.id }).from(accounts).where(eq(accounts.tgUserId, profile.tgUserId))
        if (existing) {
          // the account is already here: do not leave a second, unused session behind
          await qrClient.logOut().catch(() => {})
          await update(qrId, 'failed', { message: 'Этот аккаунт уже есть в панели', accountId: existing.id })
          return
        }
        const session = await qrClient.exportSession()
        const [created] = await db
          .insert(accounts)
          .values({
            tgUserId: profile.tgUserId,
            phone: profile.phone,
            username: profile.username,
            firstName: profile.firstName,
            lastName: profile.lastName,
            isPremium: profile.isPremium,
            dcId: profile.dcId,
            source: 'qr',
            clientProfile: 'own',
            device,
            connectionMode: proxyId ? 'proxy' : 'direct',
            proxyId,
            status: 'pending_check',
            sessionImportEnc: cipher.encrypt(session),
          })
          .returning({ id: accounts.id })
        await writeAudit(db, { actor: adminId ? { type: 'admin', adminId } : { type: 'system' }, action: 'account.qr.created', targetType: 'account', targetId: created!.id, result: 'ok' })
        await bus.publish({ type: 'accounts.changed', ids: [created!.id] })
        await update(qrId, 'done', { accountId: created!.id })
        await options.onAccountCreated?.(created!.id)
      } catch (err) {
        const reason = abort.signal.aborted ? String((abort.signal.reason as Error)?.message) : null
        if (reason === 'cancelled') await update(qrId, 'cancelled')
        else if (reason === 'expired') await update(qrId, 'expired')
        else {
          logger.warn({ err, qrId }, 'qr: login failed')
          await update(qrId, 'failed', { message: err instanceof Error ? err.message.slice(0, 300) : String(err) })
        }
      } finally {
        clearTimeout(timer)
        await stopControl()
        await client?.destroy().catch(() => {})
      }
    },
  }
}
```

- [ ] **Шаг 4: Проверки**

```bash
fnm exec --using=26 pnpm typecheck
fnm exec --using=26 pnpm lint
fnm exec --using=26 npx vitest run --project api --project worker
# всё зелёное
```

- [ ] **Шаг 5: Коммит**

```bash
git add -A
git commit -F - <<'MSG'
feat: QR login — api start/password/cancel (password over pub/sub, never stored), worker flow with in-memory client, live qr.update events, duplicate guard with logout
MSG
```

---

### Task 16: Web: аккаунты

Список (фильтры по группам статусов, поиск, меню действий), диалог «Добавить аккаунт» с вкладками «Из tdata» (загрузка с код-паролем → предпросмотр с выбором подключения на строку и «Раздать автоматически») и «По QR-коду» (QR-картинка — `qrcode`, состояния входа, форма 2FA; закрытие диалога отменяет вход), карточка аккаунта (профиль, подключение, метка и заметка, активные сессии по кнопке, коды, удаление с выходом или без).

События стрима переотправляются внутри страницы (`emitAppEvent` / `useAppEvent`). QR-вкладка держит `qr.update`, пришедший раньше ответа `POST /qr`, и применяет его, когда id известен. «Напрямую» никогда не выбирается само: без свободных прокси новые строки импорта — «Не добавлять», QR ждёт явного выбора. Старый файл-заглушка `routes/_authed/accounts.tsx` заменяется папкой `accounts/` (`index.tsx`, `$id.tsx`).

**Files:**
- Modify: `apps/web/package.json`
- Test: `apps/web/src/components/accounts/account-card.test.tsx`
- Create: `apps/web/src/components/accounts/account-notes-form.tsx`
- Create: `apps/web/src/components/accounts/account-route-form.tsx`
- Create: `apps/web/src/components/accounts/account-sessions.tsx`
- Create: `apps/web/src/components/accounts/account-status-badge.tsx`
- Create: `apps/web/src/components/accounts/add-account-dialog.tsx`
- Create: `apps/web/src/components/accounts/delete-account-dialog.tsx`
- Test: `apps/web/src/components/accounts/import-tdata-tab.test.tsx`
- Create: `apps/web/src/components/accounts/import-tdata-tab.tsx`
- Test: `apps/web/src/components/accounts/qr-login-tab.test.tsx`
- Create: `apps/web/src/components/accounts/qr-login-tab.tsx`
- Create: `apps/web/src/components/accounts/route-select.tsx`
- Create: `apps/web/src/components/codes/codes-table.tsx`
- Create: `apps/web/src/components/codes/copy-code-button.tsx`
- Create: `apps/web/src/lib/accounts.ts`
- Create: `apps/web/src/lib/app-events.ts`
- Modify: `apps/web/src/routes/_authed.tsx`
- Delete: `apps/web/src/routes/_authed/accounts.tsx`
- Create: `apps/web/src/routes/_authed/accounts/$id.tsx`
- Create: `apps/web/src/routes/_authed/accounts/index.tsx`
- Test: `apps/web/src/test/fixtures.ts`
- Test: `apps/web/src/test/render.tsx`
- Generated: `apps/web/src/routeTree.gen.ts`, `pnpm-lock.yaml` — не писать руками (команды ниже)

**Interfaces:**
- Consumes: `/api/accounts*`, `/api/imports*`, `/api/qr*`, `/api/codes` (задачи 10, 12, 14, 15); события `accounts.changed`, `code.new`, `qr.update`.
- Produces:
  - `apps/web/src/components/accounts/account-notes-form.tsx`: `AccountNotesForm({ account }: { account: AccountDto })`
  - `apps/web/src/components/accounts/account-route-form.tsx`: `AccountRouteForm({ account }: { account: AccountDto })`
  - `apps/web/src/components/accounts/account-sessions.tsx`: `AccountSessions({ accountId, running }: { accountId: string; running: boolean })`
  - `apps/web/src/components/accounts/account-status-badge.tsx`: `AccountStatusBadge({ status, reason }: { status: AccountStatus; reason?: string | null })`
  - `apps/web/src/components/accounts/add-account-dialog.tsx`: `AddAccountDialog()`
  - `apps/web/src/components/accounts/delete-account-dialog.tsx`: `DeleteAccountDialog({ account }: { account: AccountDto })`
  - `apps/web/src/components/accounts/import-tdata-tab.tsx`: `ImportTdataTab({ onDone }: { onDone: () => void })`
  - `apps/web/src/components/accounts/qr-login-tab.tsx`: `QrLoginTab({ onDone }: { onDone: () => void })`
  - `apps/web/src/components/accounts/route-select.tsx`: `type RouteChoice`; `RouteSelect(props:`
  - `apps/web/src/components/codes/codes-table.tsx`: `CodesTable({ items, showAccount, empty }: { items: CodeDto[]; showAccount?: boolean; empty: string })`
  - `apps/web/src/components/codes/copy-code-button.tsx`: `CopyCodeButton({ code }: { code: string })`
  - `apps/web/src/lib/accounts.ts`: `accountsQueryOptions`; `accountQueryOptions`; `accountSessionsQueryOptions`; `codesQueryOptions`; `accountStatusVariant: Record<AccountStatus, 'secondary' | 'outline' | 'destructive'>`; `ACCOUNT_STATUS_FILTERS`; `type AccountStatusFilter`; `freeProxies(all: ProxyDto[], keepProxyId?: string | null): ProxyDto[]`; `proxyLabel(p: Pick<ProxyDto, 'type' | 'host' | 'port' | 'tgCountry' | 'latencyMs'>): string`
  - `apps/web/src/lib/app-events.ts`: `emitAppEvent(event: AppEvent): void`; `useAppEvent(handler: (event: AppEvent) => void): void`
  - `apps/web/src/routes/_authed/accounts/$id.tsx`: `Route`
  - `apps/web/src/routes/_authed/accounts/index.tsx`: `Route`

- [ ] **Шаг 1: Зависимости**

```bash
fnm exec --using=26 pnpm --filter web add 'qrcode@^1'
fnm exec --using=26 pnpm --filter web add -D '@types/qrcode@^1'
```

- [ ] **Шаг 2: Написать падающий тест**

`apps/web/src/components/accounts/account-card.test.tsx` — новый файл

```tsx
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { AccountSessionDto } from '@workspace/shared/accounts'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { accountFixture, proxyFixture } from '@/test/fixtures'
import { json, renderWithClient } from '@/test/render'
import { AccountRouteForm } from './account-route-form'
import { AccountSessions } from './account-sessions'
import { DeleteAccountDialog } from './delete-account-dialog'

const navigate = vi.fn()
vi.mock('@tanstack/react-router', async (importOriginal) => ({ ...(await importOriginal<object>()), useNavigate: () => navigate }))

const account = accountFixture()
let fetchMock: ReturnType<typeof vi.fn>
const calls = (method: string) => fetchMock.mock.calls.filter(([, init]) => ((init as RequestInit | undefined)?.method ?? 'GET') === method).map(([url, init]) => ({ url: String(url), init: init as RequestInit }))

beforeEach(() => navigate.mockReset())
afterEach(() => vi.unstubAllGlobals())

describe('AccountRouteForm', () => {
  it('an account waiting for a proxy gets one chosen from the free ones', async () => {
    const free = proxyFixture()
    const busy = proxyFixture({ id: '00000000-0000-4000-8000-000000000002', host: '194.53.188.11', account: { id: 'x', label: 'другой', phone: null, username: null } })
    fetchMock = vi.fn(async (_url: string, init?: RequestInit) =>
      init?.method === 'PUT' ? json({ ...account, proxy: { ...free, status: 'ok' } }) : json({ items: [free, busy] }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const user = userEvent.setup()
    renderWithClient(<AccountRouteForm account={account} />)

    expect(screen.getByLabelText('Прокси')).toHaveTextContent('Выберите прокси')
    expect(screen.getByRole('button', { name: 'Сохранить и переподключить' })).toBeDisabled()

    await user.click(screen.getByLabelText('Прокси'))
    expect(await screen.findByRole('option', { name: /194\.53\.188\.10:50101/ })).toBeInTheDocument()
    expect(screen.queryByRole('option', { name: /194\.53\.188\.11/ })).not.toBeInTheDocument()
    await user.click(screen.getByRole('option', { name: /194\.53\.188\.10:50101/ }))
    await user.click(screen.getByRole('button', { name: 'Сохранить и переподключить' }))

    await waitFor(() => expect(calls('PUT')).toHaveLength(1))
    expect(calls('PUT')[0]!.url).toBe(`/api/accounts/${account.id}/proxy`)
    expect(JSON.parse(String(calls('PUT')[0]!.init.body))).toEqual({ proxyId: free.id })
  })

  it('«напрямую» sends proxyId null', async () => {
    fetchMock = vi.fn(async (_url: string, init?: RequestInit) => (init?.method === 'PUT' ? json({ ...account, connectionMode: 'direct' }) : json({ items: [] })))
    vi.stubGlobal('fetch', fetchMock)
    const user = userEvent.setup()
    renderWithClient(<AccountRouteForm account={account} />)
    await user.click(screen.getByLabelText('Прокси'))
    await user.click(await screen.findByRole('option', { name: 'Напрямую, без прокси' }))
    await user.click(screen.getByRole('button', { name: 'Сохранить и переподключить' }))
    await waitFor(() => expect(calls('PUT')).toHaveLength(1))
    expect(JSON.parse(String(calls('PUT')[0]!.init.body))).toEqual({ proxyId: null })
  })
})

describe('DeleteAccountDialog', () => {
  it('deletes with «завершить сессию» and goes back to the list', async () => {
    fetchMock = vi.fn(async () => new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetchMock)
    const user = userEvent.setup()
    renderWithClient(<DeleteAccountDialog account={account} />)

    await user.click(screen.getByRole('button', { name: 'Удалить' }))
    await user.click(screen.getByRole('checkbox', { name: 'Завершить сессию в Telegram' }))
    await user.click(screen.getAllByRole('button', { name: 'Удалить' }).at(-1)!)

    await waitFor(() => expect(navigate).toHaveBeenCalledWith({ to: '/accounts' }))
    expect(calls('DELETE')[0]!.url).toBe(`/api/accounts/${account.id}?logout=true`)
  })

  it('keeps the dialog open with the reason when Telegram logout failed', async () => {
    fetchMock = vi.fn(async () => json({ error: 'logout_failed', message: 'Не удалось завершить сессию в Telegram (аккаунт не подключён?) — удалите без выхода' }, 409))
    vi.stubGlobal('fetch', fetchMock)
    const user = userEvent.setup()
    renderWithClient(<DeleteAccountDialog account={account} />)
    await user.click(screen.getByRole('button', { name: 'Удалить' }))
    await user.click(screen.getByRole('checkbox', { name: 'Завершить сессию в Telegram' }))
    await user.click(screen.getAllByRole('button', { name: 'Удалить' }).at(-1)!)

    expect(await screen.findByText(/удалите без выхода/)).toBeInTheDocument()
    expect(navigate).not.toHaveBeenCalled()
  })
})

describe('AccountSessions', () => {
  const session = (over: Partial<AccountSessionDto>): AccountSessionDto => ({
    hash: '0',
    current: false,
    official: true,
    appName: 'Telegram Android',
    appVersion: '12.0',
    deviceModel: 'Pixel 8',
    platform: 'Android',
    systemVersion: '15',
    ip: '5.34.1.1',
    country: 'Kazakhstan',
    region: '',
    createdAt: '2026-09-01T00:00:00.000Z',
    activeAt: '2026-10-03T00:00:00.000Z',
    ...over,
  })

  it('asks Telegram only on demand and terminates another device', async () => {
    fetchMock = vi.fn(async (_url: string, init?: RequestInit) =>
      init?.method === 'DELETE'
        ? new Response(null, { status: 204 })
        : json({ items: [session({ hash: '0', current: true, appName: 'Telegram Desktop', appVersion: '7.2.9 x64' }), session({ hash: '-123456789' })] }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const user = userEvent.setup()
    renderWithClient(<AccountSessions accountId={account.id} running />)
    expect(fetchMock).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: 'Показать активные сессии' }))
    expect(await screen.findByText('Telegram Android 12.0')).toBeInTheDocument()
    expect(screen.getByText('панель')).toBeInTheDocument()
    // the panel's own session cannot be terminated from here
    expect(screen.getAllByRole('button', { name: 'Завершить' })).toHaveLength(1)

    await user.click(screen.getByRole('button', { name: 'Завершить' }))
    await user.click(screen.getAllByRole('button', { name: 'Завершить' }).at(-1)!)
    await waitFor(() => expect(calls('DELETE')).toHaveLength(1))
    expect(calls('DELETE')[0]!.url).toBe(`/api/accounts/${account.id}/sessions/-123456789`)
  })

  it('is unavailable while the account is not connected', () => {
    vi.stubGlobal('fetch', vi.fn())
    renderWithClient(<AccountSessions accountId={account.id} running={false} />)
    expect(screen.getByRole('button', { name: 'Показать активные сессии' })).toBeDisabled()
  })
})
```

`apps/web/src/components/accounts/import-tdata-tab.test.tsx` — новый файл

```tsx
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ImportBatchDto } from '@workspace/shared/accounts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { proxyFixture } from '@/test/fixtures'
import { json, renderWithClient } from '@/test/render'
import { ImportTdataTab } from './import-tdata-tab'

afterEach(() => vi.unstubAllGlobals())

const batch: ImportBatchDto = {
  id: '00000000-0000-4000-8000-0000000000b1',
  filename: 'tdata.zip',
  status: 'ready',
  createdAt: '2026-10-03T00:00:00.000Z',
  expiresAt: '2026-10-03T01:00:00.000Z',
  items: [
    { id: '00000000-0000-4000-8000-0000000000c1', pathInArchive: 'tdata', accountIndex: 0, tgUserId: 111, dcId: 2, duplicateOf: null, decision: 'pending', accountId: null },
    {
      id: '00000000-0000-4000-8000-0000000000c2',
      pathInArchive: 'tdata',
      accountIndex: 1,
      tgUserId: 222,
      dcId: 4,
      duplicateOf: { id: '00000000-0000-4000-8000-0000000000a9', label: 'old', phone: null },
      decision: 'pending',
      accountId: null,
    },
  ],
}

const zip = () => new File([new Uint8Array([0x50, 0x4b, 0x03, 0x04])], 'tdata.zip', { type: 'application/zip' })

describe('ImportTdataTab', () => {
  it('uploads the archive, proposes a free proxy for new accounts, skips duplicates and confirms', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/proxies') return json({ items: [proxyFixture()] })
      if (url === '/api/imports' && init?.method === 'POST') return json(batch, 201)
      return json({ created: 1, skipped: 1 })
    })
    vi.stubGlobal('fetch', fetchMock)
    const onDone = vi.fn()
    const user = userEvent.setup()
    renderWithClient(<ImportTdataTab onDone={onDone} />)

    await user.upload(screen.getByLabelText('Архив tdata (.zip)'), zip())
    await user.click(screen.getByRole('button', { name: 'Загрузить и проверить' }))

    expect(await screen.findByText(/найдено аккаунтов: 2/)).toBeInTheDocument()
    expect(screen.getByText('уже в панели')).toBeInTheDocument()
    expect(screen.getByLabelText('Подключение аккаунта 111')).toHaveTextContent('Свободный прокси автоматически')
    expect(screen.getByLabelText('Подключение аккаунта 222')).toHaveTextContent('Не добавлять')

    await user.click(screen.getByRole('button', { name: 'Добавить 1' }))
    await waitFor(() => expect(onDone).toHaveBeenCalled())
    const confirm = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/confirm')) as unknown as [string, RequestInit]
    expect(confirm[0]).toBe(`/api/imports/${batch.id}/confirm`)
    expect(JSON.parse(String(confirm[1].body))).toEqual({
      items: [
        { id: batch.items[0]!.id, decision: 'auto' },
        { id: batch.items[1]!.id, decision: 'skip' },
      ],
    })
  })

  it('shows a passcode error under the passcode field and sends the passcode on retry', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const form = init?.body as FormData
      return form.get('passcode') ? json(batch, 201) : json({ error: 'passcode_required', message: 'Архив защищён код-паролем — введите его' }, 400)
    })
    vi.stubGlobal('fetch', fetchMock)
    const user = userEvent.setup()
    renderWithClient(<ImportTdataTab onDone={vi.fn()} />)

    await user.upload(screen.getByLabelText('Архив tdata (.zip)'), zip())
    await user.click(screen.getByRole('button', { name: 'Загрузить и проверить' }))
    expect(await screen.findByText('Архив защищён код-паролем — введите его')).toBeInTheDocument()
    expect(screen.getByLabelText('Локальный код-пароль')).toHaveAttribute('aria-invalid', 'true')

    await user.type(screen.getByLabelText('Локальный код-пароль'), 'local-pass')
    await user.click(screen.getByRole('button', { name: 'Загрузить и проверить' }))
    expect(await screen.findByText(/найдено аккаунтов: 2/)).toBeInTheDocument()
  })

  it('without free proxies never picks «direct» on its own: new accounts default to skip', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => (url === '/api/proxies' ? json({ items: [] }) : json(batch, 201))),
    )
    const user = userEvent.setup()
    renderWithClient(<ImportTdataTab onDone={vi.fn()} />)
    await user.upload(screen.getByLabelText('Архив tdata (.zip)'), zip())
    await user.click(screen.getByRole('button', { name: 'Загрузить и проверить' }))

    expect(await screen.findByText('Свободных рабочих прокси нет')).toBeInTheDocument()
    expect(screen.getByLabelText('Подключение аккаунта 111')).toHaveTextContent('Не добавлять')
    expect(screen.getByRole('button', { name: 'Добавить 0' })).toBeDisabled()
  })
})
```

`apps/web/src/components/accounts/qr-login-tab.test.tsx` — новый файл

```tsx
import { act, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { AppEvent } from '@workspace/shared/events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { emitAppEvent } from '@/lib/app-events'
import { proxyFixture } from '@/test/fixtures'
import { json, renderWithClient } from '@/test/render'
import { QrLoginTab } from './qr-login-tab'

const navigate = vi.fn()
vi.mock('@tanstack/react-router', async (importOriginal) => ({ ...(await importOriginal<object>()), useNavigate: () => navigate }))
// jsdom has no canvas: the QR image itself is the library's business
vi.mock('qrcode', () => ({ default: { toDataURL: vi.fn(async (url: string) => `data:image/png;base64,${btoa(url)}`) } }))

const QR_ID = '00000000-0000-4000-8000-0000000000d1'
const qr = (patch: Omit<Extract<AppEvent, { type: 'qr.update' }>, 'type' | 'qrId'>, qrId = QR_ID) =>
  act(() => emitAppEvent({ type: 'qr.update', qrId, ...patch }))

let fetchMock: ReturnType<typeof vi.fn>
beforeEach(() => {
  navigate.mockReset()
  fetchMock = vi.fn(async (url: string) => {
    if (url === '/api/proxies') return json({ items: [proxyFixture()] })
    if (url === '/api/qr') return json({ qrId: QR_ID }, 201)
    return new Response(null, { status: 202 })
  })
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => vi.unstubAllGlobals())

const bodyOf = (path: string) => {
  const call = fetchMock.mock.calls.find(([url]) => url === path) as [string, RequestInit] | undefined
  return call && JSON.parse(String(call[1].body))
}

describe('QrLoginTab', () => {
  it('goes through QR → scanned → 2FA → done and opens the new account', async () => {
    const onDone = vi.fn()
    const user = userEvent.setup()
    renderWithClient(<QrLoginTab onDone={onDone} />)

    await waitFor(() => expect(screen.getByLabelText('Подключение')).toHaveTextContent('194.53.188.10:50101'))
    await user.click(screen.getByRole('button', { name: 'Показать QR-код' }))
    await waitFor(() => expect(bodyOf('/api/qr')).toEqual({ proxyId: proxyFixture().id }))

    await qr({ state: 'waiting', url: 'tg://login?token=abc' })
    expect(await screen.findByAltText('QR-код для входа в Telegram')).toHaveAttribute('src', `data:image/png;base64,${btoa('tg://login?token=abc')}`)

    await qr({ state: 'scanned' })
    expect(screen.getByText('QR отсканирован — подтвердите вход в Telegram')).toBeInTheDocument()

    await qr({ state: 'password_needed', hint: 'кот' })
    expect(screen.getByText('Подсказка: кот')).toBeInTheDocument()
    await user.type(screen.getByLabelText('Пароль двухэтапной проверки'), 'secret-2fa')
    await user.click(screen.getByRole('button', { name: 'Войти' }))
    await waitFor(() => expect(bodyOf(`/api/qr/${QR_ID}/password`)).toEqual({ password: 'secret-2fa' }))

    await qr({ state: 'password_invalid', hint: 'кот' })
    expect(screen.getByText('Неверный пароль — попробуйте ещё раз')).toBeInTheDocument()
    // the typed password is not kept after it was sent
    expect((screen.getByLabelText('Пароль двухэтапной проверки') as HTMLInputElement).value).toBe('')

    await qr({ state: 'done', accountId: '00000000-0000-4000-8000-0000000000a1' })
    expect(onDone).toHaveBeenCalled()
    expect(navigate).toHaveBeenCalledWith({ to: '/accounts/$id', params: { id: '00000000-0000-4000-8000-0000000000a1' } })
  })

  it('ignores events of other logins and keeps one that arrives before POST /qr answers', async () => {
    let answer!: () => void
    fetchMock.mockImplementation(async (url: string) => {
      if (url === '/api/proxies') return json({ items: [proxyFixture()] })
      if (url === '/api/qr') {
        await new Promise<void>((resolve) => (answer = resolve))
        return json({ qrId: QR_ID }, 201)
      }
      return new Response(null, { status: 202 })
    })
    const user = userEvent.setup()
    renderWithClient(<QrLoginTab onDone={vi.fn()} />)
    await waitFor(() => expect(screen.getByLabelText('Подключение')).toHaveTextContent('194.53.188.10'))
    await user.click(screen.getByRole('button', { name: 'Показать QR-код' }))
    await waitFor(() => expect(answer).toBeTypeOf('function'))

    await qr({ state: 'waiting', url: 'tg://login?token=early' })
    await act(async () => answer())
    expect(await screen.findByAltText('QR-код для входа в Telegram')).toHaveAttribute('src', `data:image/png;base64,${btoa('tg://login?token=early')}`)

    await qr({ state: 'failed', message: 'чужой вход' }, '00000000-0000-4000-8000-0000000000ff')
    expect(screen.queryByText('Не удалось войти')).not.toBeInTheDocument()
  })

  it('shows why the login failed and starts over', async () => {
    const user = userEvent.setup()
    renderWithClient(<QrLoginTab onDone={vi.fn()} />)
    await waitFor(() => expect(screen.getByLabelText('Подключение')).toHaveTextContent('194.53.188.10'))
    await user.click(screen.getByRole('button', { name: 'Показать QR-код' }))
    await waitFor(() => expect(bodyOf('/api/qr')).toBeDefined())
    await qr({ state: 'failed', message: 'Этот аккаунт уже есть в панели' })

    expect(await screen.findByText('Не удалось войти')).toBeInTheDocument()
    expect(screen.getByText('Этот аккаунт уже есть в панели')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Начать заново' }))
    expect(screen.getByRole('button', { name: 'Показать QR-код' })).toBeInTheDocument()
  })

  it('cancels a running login on the worker when closed', async () => {
    const user = userEvent.setup()
    const { unmount } = renderWithClient(<QrLoginTab onDone={vi.fn()} />)
    await waitFor(() => expect(screen.getByLabelText('Подключение')).toHaveTextContent('194.53.188.10'))
    await user.click(screen.getByRole('button', { name: 'Показать QR-код' }))
    await qr({ state: 'waiting', url: 'tg://login?token=abc' })
    await screen.findByAltText('QR-код для входа в Telegram')

    unmount()
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(`/api/qr/${QR_ID}`, expect.objectContaining({ method: 'DELETE' })))
  })

  it('without free proxies waits for an explicit choice instead of going direct', async () => {
    fetchMock.mockImplementation(async (url: string) => (url === '/api/proxies' ? json({ items: [] }) : json({ qrId: QR_ID }, 201)))
    renderWithClient(<QrLoginTab onDone={vi.fn()} />)
    await waitFor(() => expect(screen.getByLabelText('Подключение')).toHaveTextContent('Свободных прокси нет — выберите вариант'))
    expect(screen.getByRole('button', { name: 'Показать QR-код' })).toBeDisabled()
  })
})
```

`apps/web/src/test/fixtures.ts` — новый файл

```ts
import type { AccountDto } from '@workspace/shared/accounts'
import type { ProxyDto } from '@workspace/shared/proxies'

export function proxyFixture(over: Partial<ProxyDto> = {}): ProxyDto {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    source: 'proxy_store',
    externalId: null,
    type: 'socks5',
    host: '194.53.188.10',
    port: 50101,
    username: 'kz',
    hasPassword: true,
    tag: null,
    status: 'ok',
    lastCheckAt: null,
    lastOkAt: null,
    latencyMs: 120,
    tgCountry: 'KZ',
    lastError: null,
    failStreak: 0,
    expiresAt: null,
    disabledAt: null,
    createdAt: '2026-10-03T00:00:00.000Z',
    account: null,
    ...over,
  }
}

export function accountFixture(over: Partial<AccountDto> = {}): AccountDto {
  return {
    id: '00000000-0000-4000-8000-0000000000a1',
    tgUserId: 7_000_001,
    phone: '77001234567',
    username: null,
    firstName: 'Тест',
    lastName: null,
    isPremium: false,
    dcId: 2,
    label: null,
    note: null,
    source: 'tdata',
    clientProfile: 'desktop',
    device: { deviceModel: 'Desktop', systemVersion: 'Windows 11 x64', appVersion: '7.2.9 x64', langCode: 'ru' },
    connectionMode: 'proxy',
    proxy: null,
    status: 'active',
    statusReason: null,
    statusChangedAt: '2026-10-03T00:00:00.000Z',
    lastOkAt: null,
    frozenUntil: null,
    lastCodeAt: null,
    createdAt: '2026-10-03T00:00:00.000Z',
    ...over,
  }
}
```

`apps/web/src/test/render.tsx` — новый файл

```tsx
import type * as React from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render } from '@testing-library/react'
import { Toaster } from '@workspace/ui/components/toast'

export const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

/** Renders with a fresh query client (no retries) and the toast host; returns the client to seed or inspect. */
export function renderWithClient(ui: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const result = render(
    <QueryClientProvider client={client}>
      <Toaster>{ui}</Toaster>
    </QueryClientProvider>,
  )
  return { client, ...result }
}
```

- [ ] **Шаг 3: Убедиться, что тест падает**

```bash
fnm exec --using=26 npx vitest run --project web apps/web/src/components/accounts
# FAIL: Cannot find module './import-tdata-tab'
```

- [ ] **Шаг 4: Реализация**

`apps/web/package.json` — изменения

```diff
--- a/apps/web/package.json
+++ b/apps/web/package.json
@@ -19,6 +19,7 @@
     "@workspace/shared": "workspace:*",
     "@workspace/ui": "workspace:*",
     "lucide-react": "^1.49.0",
+    "qrcode": "^1.5.4",
     "react": "^19.2.8",
     "react-dom": "^19.2.8",
     "zod": "^4.6.5"
@@ -32,6 +33,7 @@
     "@testing-library/react": "^16.3.3",
     "@testing-library/user-event": "^14.6.7",
     "@types/node": "^24",
+    "@types/qrcode": "^1.5.6",
     "@types/react": "^19",
     "@types/react-dom": "^19",
     "@vitejs/plugin-react": "^6",
```

`apps/web/src/components/accounts/account-notes-form.tsx` — новый файл

```tsx
import * as React from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { AccountDto } from '@workspace/shared/accounts'
import { Button } from '@workspace/ui/components/button'
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from '@workspace/ui/components/field'
import { Input } from '@workspace/ui/components/input'
import { Textarea } from '@workspace/ui/components/textarea'
import { toast } from '@workspace/ui/components/toast'
import { accountQueryOptions, accountsQueryOptions } from '@/lib/accounts'
import { api, ApiError } from '@/lib/api'

export function AccountNotesForm({ account }: { account: AccountDto }) {
  const queryClient = useQueryClient()
  const [label, setLabel] = React.useState(account.label ?? '')
  const [note, setNote] = React.useState(account.note ?? '')

  const save = useMutation({
    mutationFn: () => api<AccountDto>(`/accounts/${account.id}`, { method: 'PATCH', json: { label: label.trim() || null, note: note.trim() || null } }),
    onSuccess: async (updated) => {
      queryClient.setQueryData(accountQueryOptions(account.id).queryKey, updated)
      await queryClient.invalidateQueries({ queryKey: accountsQueryOptions.queryKey, exact: true })
      toast.add({ title: 'Сохранено' })
    },
  })
  const fields = save.error instanceof ApiError ? save.error.fields : {}
  const dirty = label !== (account.label ?? '') || note !== (account.note ?? '')

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        save.mutate()
      }}
    >
      <FieldGroup>
        <Field data-invalid={!!fields.label || undefined}>
          <FieldLabel htmlFor="account-label">Метка</FieldLabel>
          <Input id="account-label" maxLength={64} value={label} onChange={(e) => setLabel(e.target.value)} aria-invalid={!!fields.label || undefined} />
          <FieldDescription>Показывается вместо телефона в списках и уведомлениях панели.</FieldDescription>
          {fields.label && <FieldError>{fields.label}</FieldError>}
        </Field>
        <Field data-invalid={!!fields.note || undefined}>
          <FieldLabel htmlFor="account-note">Заметка</FieldLabel>
          <Textarea id="account-note" maxLength={2000} rows={3} value={note} onChange={(e) => setNote(e.target.value)} aria-invalid={!!fields.note || undefined} />
          {fields.note && <FieldError>{fields.note}</FieldError>}
        </Field>
        {save.error && !Object.keys(fields).length && <FieldError>{save.error.message}</FieldError>}
        <Field orientation="horizontal">
          <Button type="submit" disabled={!dirty || save.isPending}>
            Сохранить
          </Button>
        </Field>
      </FieldGroup>
    </form>
  )
}
```

`apps/web/src/components/accounts/account-route-form.tsx` — новый файл

```tsx
import * as React from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { AccountDto } from '@workspace/shared/accounts'
import { Button } from '@workspace/ui/components/button'
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from '@workspace/ui/components/field'
import { toast } from '@workspace/ui/components/toast'
import { accountQueryOptions, accountsQueryOptions, freeProxies } from '@/lib/accounts'
import { api } from '@/lib/api'
import { proxiesQueryOptions } from '@/lib/proxies'
import { RouteSelect, type RouteChoice } from './route-select'

const DIRECT = 'direct'

function currentRoute(a: AccountDto): RouteChoice | null {
  return a.proxy?.id ?? (a.connectionMode === 'direct' ? DIRECT : null)
}

/** Which proxy the account goes through; «напрямую» is only an explicit choice. */
export function AccountRouteForm({ account }: { account: AccountDto }) {
  const queryClient = useQueryClient()
  const proxies = useQuery(proxiesQueryOptions)
  const [choice, setChoice] = React.useState<RouteChoice | null>(currentRoute(account))
  // follow changes made elsewhere (another admin, the worker re-assigning) unless the admin is mid-edit
  const saved = currentRoute(account)
  const [lastSaved, setLastSaved] = React.useState(saved)
  if (saved !== lastSaved) {
    setLastSaved(saved)
    setChoice(saved)
  }

  const save = useMutation({
    mutationFn: () => api<AccountDto>(`/accounts/${account.id}/proxy`, { method: 'PUT', json: { proxyId: choice === DIRECT ? null : choice } }),
    onSuccess: async (updated) => {
      queryClient.setQueryData(accountQueryOptions(account.id).queryKey, updated)
      await queryClient.invalidateQueries({ queryKey: accountsQueryOptions.queryKey, exact: true })
      await queryClient.invalidateQueries({ queryKey: proxiesQueryOptions.queryKey })
      toast.add({ title: 'Подключение изменено', description: 'Аккаунт переподключается' })
    },
  })

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        save.mutate()
      }}
    >
      <FieldGroup>
        <Field data-invalid={!!save.error || undefined}>
          <FieldLabel htmlFor="account-route">Прокси</FieldLabel>
          <RouteSelect
            id="account-route"
            value={choice}
            onChange={setChoice}
            proxies={freeProxies(proxies.data?.items ?? [], account.proxy?.id)}
            special={[{ value: DIRECT, label: 'Напрямую, без прокси' }]}
            placeholder="Выберите прокси"
          />
          <FieldDescription>
            Один прокси — один аккаунт. Без прокси Telegram увидит IP сервера панели — выбирайте это только осознанно.
          </FieldDescription>
          {save.error && <FieldError>{save.error.message}</FieldError>}
        </Field>
        <Field orientation="horizontal">
          <Button type="submit" disabled={choice === null || choice === saved || save.isPending}>
            Сохранить и переподключить
          </Button>
        </Field>
      </FieldGroup>
    </form>
  )
}
```

`apps/web/src/components/accounts/account-sessions.tsx` — новый файл

```tsx
import * as React from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { AccountSessionDto } from '@workspace/shared/accounts'
import { Alert, AlertDescription } from '@workspace/ui/components/alert'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@workspace/ui/components/alert-dialog'
import { Badge } from '@workspace/ui/components/badge'
import { Button } from '@workspace/ui/components/button'
import { Spinner } from '@workspace/ui/components/spinner'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@workspace/ui/components/table'
import { toast } from '@workspace/ui/components/toast'
import { accountSessionsQueryOptions } from '@/lib/accounts'
import { api, ApiError } from '@/lib/api'
import { formatDateTime, formatRelative } from '@/lib/format'

function sessionTitle(s: AccountSessionDto): string {
  return `${s.appName} ${s.appVersion}`.trim()
}

/** Active Telegram sessions: fetched only on demand — the request goes through the worker to Telegram and is audited. */
export function AccountSessions({ accountId, running }: { accountId: string; running: boolean }) {
  const queryClient = useQueryClient()
  const [shown, setShown] = React.useState(false)
  const [target, setTarget] = React.useState<AccountSessionDto | null>(null)
  const sessions = useQuery({ ...accountSessionsQueryOptions(accountId), enabled: shown })

  const terminate = useMutation({
    mutationFn: (s: AccountSessionDto) => api(`/accounts/${accountId}/sessions/${s.hash}`, { method: 'DELETE' }),
    onSuccess: (_, s) => toast.add({ title: 'Сессия завершена', description: sessionTitle(s) }),
    onError: (err) => toast.add({ title: 'Не удалось завершить сессию', description: err instanceof ApiError ? err.message : String(err) }),
    onSettled: async () => {
      setTarget(null)
      await queryClient.invalidateQueries({ queryKey: accountSessionsQueryOptions(accountId).queryKey })
    },
  })

  if (!shown) {
    return (
      <div className="flex flex-col items-start gap-2">
        <p className="text-muted-foreground text-sm">Список устройств запрашивается у Telegram по кнопке; каждый просмотр пишется в аудит.</p>
        <Button variant="outline" disabled={!running} onClick={() => setShown(true)}>
          Показать активные сессии
        </Button>
      </div>
    )
  }
  if (sessions.isPending) return <Spinner />
  if (sessions.error) {
    return (
      <Alert variant="destructive">
        <AlertDescription>{sessions.error.message}</AlertDescription>
      </Alert>
    )
  }

  return (
    <>
      <div className="overflow-hidden rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Приложение</TableHead>
              <TableHead>Устройство</TableHead>
              <TableHead>IP и страна</TableHead>
              <TableHead>Активность</TableHead>
              <TableHead>
                <span className="sr-only">Действия</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {sessions.data.items.map((s) => (
              <TableRow key={s.hash}>
                <TableCell>
                  <span className="flex items-center gap-2">
                    {sessionTitle(s)}
                    {s.current && <Badge variant="secondary">панель</Badge>}
                    {!s.official && <Badge variant="outline">неофициальное</Badge>}
                  </span>
                </TableCell>
                <TableCell className="text-sm">{[s.deviceModel, s.platform, s.systemVersion].filter(Boolean).join(', ')}</TableCell>
                <TableCell className="text-sm">{[s.ip, s.country].filter(Boolean).join(' · ')}</TableCell>
                <TableCell className="text-sm" title={`вход: ${formatDateTime(s.createdAt)}`}>
                  {formatRelative(s.activeAt)}
                </TableCell>
                <TableCell className="text-right">
                  {!s.current && (
                    <Button variant="ghost" size="sm" onClick={() => setTarget(s)}>
                      Завершить
                    </Button>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <AlertDialog open={target !== null} onOpenChange={(open) => !open && setTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Завершить сессию {target && sessionTitle(target)}?</AlertDialogTitle>
            <AlertDialogDescription>Устройство выйдет из аккаунта. Telegram может не дать завершить чужие сессии, если сессия панели моложе суток.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Отмена</AlertDialogCancel>
            <AlertDialogAction variant="destructive" disabled={terminate.isPending} onClick={() => target && terminate.mutate(target)}>
              Завершить
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
```

`apps/web/src/components/accounts/account-status-badge.tsx` — новый файл

```tsx
import { accountStatusLabels, type AccountStatus } from '@workspace/shared/accounts'
import { Badge } from '@workspace/ui/components/badge'
import { Tooltip, TooltipContent, TooltipTrigger } from '@workspace/ui/components/tooltip'
import { accountStatusVariant } from '@/lib/accounts'

export function AccountStatusBadge({ status, reason }: { status: AccountStatus; reason?: string | null }) {
  const badge = <Badge variant={accountStatusVariant[status]}>{accountStatusLabels[status]}</Badge>
  if (!reason) return badge
  return (
    <Tooltip>
      <TooltipTrigger render={<span />}>{badge}</TooltipTrigger>
      <TooltipContent>{reason}</TooltipContent>
    </Tooltip>
  )
}
```

`apps/web/src/components/accounts/add-account-dialog.tsx` — новый файл

```tsx
import * as React from 'react'
import { Button } from '@workspace/ui/components/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@workspace/ui/components/dialog'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@workspace/ui/components/tabs'
import { PlusIcon } from 'lucide-react'
import { ImportTdataTab } from './import-tdata-tab'
import { QrLoginTab } from './qr-login-tab'

export function AddAccountDialog() {
  const [open, setOpen] = React.useState(false)
  // a fresh key per opening: closing drops typed passcodes, uploads and a running QR login
  const [session, setSession] = React.useState(0)
  const close = () => setOpen(false)
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (next) setSession((s) => s + 1)
      }}
    >
      <DialogTrigger render={<Button />}>
        <PlusIcon data-icon="inline-start" />
        Добавить аккаунт
      </DialogTrigger>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Новый аккаунт</DialogTitle>
          <DialogDescription>Перенос сессии из Telegram Desktop или вход новой сессией по QR-коду.</DialogDescription>
        </DialogHeader>
        <Tabs defaultValue="tdata" key={session}>
          <TabsList>
            <TabsTrigger value="tdata">Из tdata</TabsTrigger>
            <TabsTrigger value="qr">По QR-коду</TabsTrigger>
          </TabsList>
          <TabsContent value="tdata" className="pt-4">
            <ImportTdataTab onDone={close} />
          </TabsContent>
          <TabsContent value="qr" className="pt-4">
            <QrLoginTab onDone={close} />
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  )
}
```

`apps/web/src/components/accounts/delete-account-dialog.tsx` — новый файл

```tsx
import * as React from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { accountTitle, type AccountDto } from '@workspace/shared/accounts'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@workspace/ui/components/alert-dialog'
import { Button } from '@workspace/ui/components/button'
import { Checkbox } from '@workspace/ui/components/checkbox'
import { Field, FieldContent, FieldDescription, FieldError, FieldLabel } from '@workspace/ui/components/field'
import { toast } from '@workspace/ui/components/toast'
import { Trash2Icon } from 'lucide-react'
import { accountsQueryOptions } from '@/lib/accounts'
import { api } from '@/lib/api'
import { proxiesQueryOptions } from '@/lib/proxies'

export function DeleteAccountDialog({ account }: { account: AccountDto }) {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const [open, setOpen] = React.useState(false)
  const [logout, setLogout] = React.useState(false)

  const remove = useMutation({
    mutationFn: () => api(`/accounts/${account.id}?logout=${logout}`, { method: 'DELETE' }),
    onSuccess: async () => {
      toast.add({ title: 'Аккаунт удалён', description: accountTitle(account) })
      queryClient.removeQueries({ queryKey: ['accounts', account.id] })
      await queryClient.invalidateQueries({ queryKey: accountsQueryOptions.queryKey, exact: true })
      await queryClient.invalidateQueries({ queryKey: proxiesQueryOptions.queryKey })
      await navigate({ to: '/accounts' })
    },
  })

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) {
          setLogout(false)
          remove.reset()
        }
      }}
    >
      <AlertDialogTrigger render={<Button variant="destructive" />}>
        <Trash2Icon data-icon="inline-start" />
        Удалить
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Удалить аккаунт {accountTitle(account)}?</AlertDialogTitle>
          <AlertDialogDescription>Из панели исчезнут сессия, коды и история аккаунта. Прокси освободится.</AlertDialogDescription>
        </AlertDialogHeader>
        <Field orientation="horizontal">
          <Checkbox id="delete-logout" checked={logout} onCheckedChange={(v) => setLogout(v === true)} />
          <FieldContent>
            <FieldLabel htmlFor="delete-logout">Завершить сессию в Telegram</FieldLabel>
            <FieldDescription>Без этого сессия панели останется в списке устройств аккаунта.</FieldDescription>
          </FieldContent>
        </Field>
        {remove.error && <FieldError>{remove.error.message}</FieldError>}
        <AlertDialogFooter>
          <AlertDialogCancel>Отмена</AlertDialogCancel>
          <AlertDialogAction variant="destructive" disabled={remove.isPending} onClick={() => remove.mutate()}>
            Удалить
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
```

`apps/web/src/components/accounts/import-tdata-tab.tsx` — новый файл

```tsx
import * as React from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { ConfirmImportInput, ConfirmImportResult, ImportBatchDto } from '@workspace/shared/accounts'
import { Alert, AlertDescription, AlertTitle } from '@workspace/ui/components/alert'
import { Badge } from '@workspace/ui/components/badge'
import { Button } from '@workspace/ui/components/button'
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from '@workspace/ui/components/field'
import { Input } from '@workspace/ui/components/input'
import { Spinner } from '@workspace/ui/components/spinner'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@workspace/ui/components/table'
import { toast } from '@workspace/ui/components/toast'
import { WandSparklesIcon } from 'lucide-react'
import { PasswordInput } from '@/components/password-input'
import { accountsQueryOptions, freeProxies } from '@/lib/accounts'
import { api, ApiError } from '@/lib/api'
import { proxiesQueryOptions } from '@/lib/proxies'
import { RouteSelect, type RouteChoice } from './route-select'

const SPECIAL = [
  { value: 'auto', label: 'Свободный прокси автоматически' },
  { value: 'direct', label: 'Напрямую, без прокси' },
  { value: 'skip', label: 'Не добавлять' },
]

export function ImportTdataTab({ onDone }: { onDone: () => void }) {
  const queryClient = useQueryClient()
  const [file, setFile] = React.useState<File | null>(null)
  const [passcode, setPasscode] = React.useState('')
  const [choices, setChoices] = React.useState<Record<string, RouteChoice>>({})
  const proxies = useQuery(proxiesQueryOptions)
  const free = freeProxies(proxies.data?.items ?? [])

  const upload = useMutation({
    mutationFn: () => {
      const form = new FormData()
      form.set('file', file!)
      if (passcode) form.set('passcode', passcode)
      return api<ImportBatchDto>('/imports', { method: 'POST', body: form })
    },
    onSuccess: (batch) => {
      // duplicates can only be skipped; «direct» is never chosen for the admin
      setChoices(Object.fromEntries(batch.items.map((i) => [i.id, i.duplicateOf || free.length === 0 ? 'skip' : 'auto'])))
    },
  })
  const batch = upload.data

  const confirm = useMutation({
    mutationFn: () => {
      const items: ConfirmImportInput['items'] = batch!.items.map((i) => {
        const choice = choices[i.id] ?? 'skip'
        if (choice === 'auto' || choice === 'direct' || choice === 'skip') return { id: i.id, decision: choice }
        return { id: i.id, decision: 'proxy', proxyId: choice }
      })
      return api<ConfirmImportResult>(`/imports/${batch!.id}/confirm`, { method: 'POST', json: { items } })
    },
    onSuccess: async (result) => {
      await queryClient.invalidateQueries({ queryKey: accountsQueryOptions.queryKey })
      await queryClient.invalidateQueries({ queryKey: proxiesQueryOptions.queryKey })
      toast.add({ title: `Добавлено аккаунтов: ${result.created}`, description: 'Подключение и проверка займут несколько секунд' })
      onDone()
    },
  })

  const uploadError = upload.error instanceof ApiError ? upload.error : null
  const passcodeError = uploadError?.body?.error === 'passcode_required' || uploadError?.body?.error === 'passcode_invalid' ? uploadError.message : undefined
  const chosen = batch ? batch.items.map((i) => choices[i.id]).filter((c): c is string => !!c && !['auto', 'direct', 'skip'].includes(c)) : []
  const sameProxyTwice = new Set(chosen).size !== chosen.length
  const autoCount = batch ? batch.items.filter((i) => choices[i.id] === 'auto').length : 0
  const notEnough = autoCount > free.length - chosen.length
  const toAdd = batch ? batch.items.filter((i) => choices[i.id] && choices[i.id] !== 'skip').length : 0

  if (!batch) {
    return (
      <form
        className="flex flex-col gap-6"
        onSubmit={(e) => {
          e.preventDefault()
          upload.mutate()
        }}
      >
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="tdata-file">Архив tdata (.zip)</FieldLabel>
            <Input id="tdata-file" type="file" accept=".zip,application/zip" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
            <FieldDescription>Папку tdata можно положить в архив на любой глубине; аккаунтов внутри может быть несколько.</FieldDescription>
          </Field>
          <Field data-invalid={passcodeError ? true : undefined}>
            <FieldLabel htmlFor="tdata-passcode">Локальный код-пароль</FieldLabel>
            <PasswordInput id="tdata-passcode" autoComplete="off" value={passcode} onChange={(e) => setPasscode(e.target.value)} aria-invalid={passcodeError ? true : undefined} />
            <FieldDescription>Только если в Telegram Desktop включён код-пароль на приложение.</FieldDescription>
            {passcodeError && <FieldError>{passcodeError}</FieldError>}
          </Field>
        </FieldGroup>
        {upload.error && !passcodeError && (
          <Alert variant="destructive">
            <AlertTitle>Не удалось прочитать архив</AlertTitle>
            <AlertDescription>{upload.error.message}</AlertDescription>
          </Alert>
        )}
        <Alert>
          <AlertTitle>После переноса этот Telegram Desktop больше не запускайте</AlertTitle>
          <AlertDescription>Одна сессия с двух мест одновременно — и Telegram отзовёт её на обоих.</AlertDescription>
        </Alert>
        <div className="flex justify-end">
          <Button type="submit" disabled={!file || upload.isPending}>
            {upload.isPending && <Spinner data-icon="inline-start" />}
            Загрузить и проверить
          </Button>
        </div>
      </form>
    )
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-muted-foreground text-sm">
          В архиве {batch.filename} найдено аккаунтов: {batch.items.length}. Выберите, через что каждый будет подключаться.
        </p>
        <Button
          variant="outline"
          size="sm"
          disabled={free.length === 0}
          onClick={() => setChoices(Object.fromEntries(batch.items.map((i) => [i.id, i.duplicateOf ? 'skip' : 'auto'])))}
        >
          <WandSparklesIcon data-icon="inline-start" />
          Раздать автоматически
        </Button>
      </div>
      <div className="overflow-x-auto rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Telegram ID</TableHead>
              <TableHead>DC</TableHead>
              <TableHead>Путь в архиве</TableHead>
              <TableHead>Подключение</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {batch.items.map((item) => (
              <TableRow key={item.id}>
                <TableCell className="font-mono text-xs">
                  {item.tgUserId}
                  {item.duplicateOf && (
                    <Badge variant="outline" className="ml-2">
                      уже в панели
                    </Badge>
                  )}
                </TableCell>
                <TableCell>{item.dcId}</TableCell>
                <TableCell className="text-muted-foreground font-mono text-xs">
                  {item.pathInArchive} #{item.accountIndex}
                </TableCell>
                <TableCell>
                  <RouteSelect
                    aria-label={`Подключение аккаунта ${item.tgUserId}`}
                    value={choices[item.id] ?? 'skip'}
                    onChange={(value) => setChoices((c) => ({ ...c, [item.id]: value }))}
                    proxies={free}
                    special={item.duplicateOf ? SPECIAL.filter((s) => s.value === 'skip') : SPECIAL}
                    disabled={!!item.duplicateOf}
                  />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      {free.length === 0 && (
        <Alert>
          <AlertTitle>Свободных рабочих прокси нет</AlertTitle>
          <AlertDescription>Добавьте прокси на странице «Прокси» или явно выберите «Напрямую» — тогда Telegram увидит IP сервера.</AlertDescription>
        </Alert>
      )}
      {(sameProxyTwice || notEnough) && (
        <Alert variant="destructive">
          <AlertDescription>{sameProxyTwice ? 'Один прокси выбран для двух аккаунтов.' : `Для «автоматически» не хватает свободных прокси: нужно ${autoCount}.`}</AlertDescription>
        </Alert>
      )}
      {confirm.error && (
        <Alert variant="destructive">
          <AlertDescription>{confirm.error.message}</AlertDescription>
        </Alert>
      )}
      <div className="flex justify-end gap-2">
        <Button
          variant="ghost"
          onClick={() => {
            upload.reset()
            setFile(null)
          }}
        >
          Другой архив
        </Button>
        <Button disabled={toAdd === 0 || sameProxyTwice || notEnough || confirm.isPending} onClick={() => confirm.mutate()}>
          {confirm.isPending && <Spinner data-icon="inline-start" />}
          Добавить {toAdd}
        </Button>
      </div>
    </div>
  )
}
```

`apps/web/src/components/accounts/qr-login-tab.tsx` — новый файл

```tsx
import * as React from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import type { QrState } from '@workspace/shared/accounts'
import { Alert, AlertDescription, AlertTitle } from '@workspace/ui/components/alert'
import { Button } from '@workspace/ui/components/button'
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from '@workspace/ui/components/field'
import { Spinner } from '@workspace/ui/components/spinner'
import { toast } from '@workspace/ui/components/toast'
import QRCode from 'qrcode'
import { PasswordInput } from '@/components/password-input'
import { accountsQueryOptions, freeProxies } from '@/lib/accounts'
import { api } from '@/lib/api'
import { useAppEvent } from '@/lib/app-events'
import { proxiesQueryOptions } from '@/lib/proxies'
import { RouteSelect } from './route-select'

interface QrProgress {
  state: QrState
  url?: string
  hint?: string
  message?: string
  accountId?: string
}

const FINISHED: QrState[] = ['done', 'failed', 'expired', 'cancelled']

export function QrLoginTab({ onDone }: { onDone: () => void }) {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const proxies = useQuery(proxiesQueryOptions)
  const free = freeProxies(proxies.data?.items ?? [])
  const [route, setRoute] = React.useState<string | null>(null)
  const [qrId, setQrId] = React.useState<string | null>(null)
  const [progress, setProgress] = React.useState<QrProgress | null>(null)
  const [image, setImage] = React.useState<string | null>(null)
  const [password, setPassword] = React.useState('')
  // «напрямую» only by an explicit choice: with no free proxy the admin has to pick it
  const effectiveRoute = route ?? free[0]?.id ?? null
  // the worker may publish the first QR before POST /qr answers: keep such events until the id is known
  const early = React.useRef(new Map<string, QrProgress>())

  const start = useMutation({
    mutationFn: () => api<{ qrId: string }>('/qr', { method: 'POST', json: { proxyId: effectiveRoute === 'direct' ? null : effectiveRoute } }),
    onSuccess: ({ qrId }) => {
      setQrId(qrId)
      setProgress(early.current.get(qrId) ?? { state: 'waiting' })
      early.current.clear()
    },
  })
  const sendPassword = useMutation({
    mutationFn: () => api(`/qr/${qrId}/password`, { method: 'POST', json: { password } }),
    onSuccess: () => setPassword(''),
  })

  useAppEvent((event) => {
    if (event.type !== 'qr.update') return
    if (event.qrId !== qrId) {
      if (start.isPending) early.current.set(event.qrId, event)
      return
    }
    setProgress(event)
    if (event.state === 'done') {
      void queryClient.invalidateQueries({ queryKey: accountsQueryOptions.queryKey })
      toast.add({ title: 'Аккаунт добавлен по QR' })
      onDone()
      if (event.accountId) void navigate({ to: '/accounts/$id', params: { id: event.accountId } })
    }
  })

  React.useEffect(() => {
    if (!progress?.url) return
    let cancelled = false
    void QRCode.toDataURL(progress.url, { margin: 1, width: 240 }).then((data) => !cancelled && setImage(data))
    return () => {
      cancelled = true
    }
  }, [progress?.url])

  // closing the dialog mid-login cancels it on the worker
  const live = qrId !== null && progress !== null && !FINISHED.includes(progress.state)
  const liveRef = React.useRef({ live, qrId })
  React.useEffect(() => {
    liveRef.current = { live, qrId }
  })
  React.useEffect(
    () => () => {
      if (liveRef.current.live) void api(`/qr/${liveRef.current.qrId}`, { method: 'DELETE' }).catch(() => {})
    },
    [],
  )

  const reset = () => {
    setQrId(null)
    setProgress(null)
    setImage(null)
    start.reset()
  }

  if (!qrId || !progress) {
    return (
      <div className="flex flex-col gap-6">
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="qr-route">Подключение</FieldLabel>
            <RouteSelect
              id="qr-route"
              value={effectiveRoute}
              onChange={setRoute}
              proxies={free}
              special={[{ value: 'direct', label: 'Напрямую, без прокси' }]}
              placeholder="Свободных прокси нет — выберите вариант"
            />
            <FieldDescription>Новая сессия сразу пойдёт через выбранный прокси. Нужен свой api_id (Настройки → Telegram).</FieldDescription>
          </Field>
        </FieldGroup>
        {start.error && (
          <Alert variant="destructive">
            <AlertDescription>{start.error.message}</AlertDescription>
          </Alert>
        )}
        <div className="flex justify-end">
          <Button disabled={effectiveRoute === null || start.isPending} onClick={() => start.mutate()}>
            {start.isPending && <Spinner data-icon="inline-start" />}
            Показать QR-код
          </Button>
        </div>
      </div>
    )
  }

  if (progress.state === 'failed' || progress.state === 'expired' || progress.state === 'cancelled') {
    return (
      <div className="flex flex-col gap-4">
        <Alert variant="destructive">
          <AlertTitle>{progress.state === 'expired' ? 'Время на вход истекло' : progress.state === 'cancelled' ? 'Вход отменён' : 'Не удалось войти'}</AlertTitle>
          {progress.message && <AlertDescription>{progress.message}</AlertDescription>}
        </Alert>
        <div className="flex justify-end">
          <Button onClick={reset}>Начать заново</Button>
        </div>
      </div>
    )
  }

  if (progress.state === 'password_needed' || progress.state === 'password_invalid') {
    const invalid = progress.state === 'password_invalid'
    return (
      <form
        className="flex flex-col gap-6"
        onSubmit={(e) => {
          e.preventDefault()
          sendPassword.mutate()
        }}
      >
        <Field data-invalid={invalid ? true : undefined}>
          <FieldLabel htmlFor="qr-password">Пароль двухэтапной проверки</FieldLabel>
          <PasswordInput id="qr-password" autoFocus autoComplete="off" required value={password} onChange={(e) => setPassword(e.target.value)} aria-invalid={invalid ? true : undefined} />
          {progress.hint && <FieldDescription>Подсказка: {progress.hint}</FieldDescription>}
          {invalid && <FieldError>Неверный пароль — попробуйте ещё раз</FieldError>}
        </Field>
        <div className="flex justify-end">
          <Button type="submit" disabled={!password || sendPassword.isPending}>
            {sendPassword.isPending && <Spinner data-icon="inline-start" />}
            Войти
          </Button>
        </div>
      </form>
    )
  }

  return (
    <div className="flex flex-col items-center gap-4 text-center">
      {progress.state === 'scanned' || progress.state === 'done' || !image ? (
        <div className="flex h-60 flex-col items-center justify-center gap-3">
          <Spinner />
          <p className="text-muted-foreground text-sm">{progress.state === 'scanned' ? 'QR отсканирован — подтвердите вход в Telegram' : 'Готовим QR-код…'}</p>
        </div>
      ) : (
        <img src={image} alt="QR-код для входа в Telegram" className="size-60 rounded-lg bg-white p-2" />
      )}
      <p className="text-muted-foreground max-w-sm text-sm">Откройте Telegram на телефоне: Настройки → Устройства → Подключить устройство — и наведите камеру на код.</p>
    </div>
  )
}
```

`apps/web/src/components/accounts/route-select.tsx` — новый файл

```tsx
import type { ProxyDto } from '@workspace/shared/proxies'
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectSeparator, SelectTrigger, SelectValue } from '@workspace/ui/components/select'
import { proxyLabel } from '@/lib/accounts'

/** How an account reaches Telegram: a proxy id, or one of the special choices. */
export type RouteChoice = string

export function RouteSelect(props: {
  id?: string
  value: RouteChoice | null
  onChange: (value: RouteChoice) => void
  proxies: ProxyDto[]
  /** extra choices before the proxy list, e.g. auto / direct / skip */
  special: { value: string; label: string }[]
  disabled?: boolean
  placeholder?: string
  'aria-label'?: string
}) {
  const items = [...props.special, ...props.proxies.map((p) => ({ value: p.id, label: proxyLabel(p) }))]
  return (
    <Select items={items} value={props.value} onValueChange={(v) => v && props.onChange(v)} disabled={props.disabled}>
      <SelectTrigger id={props.id} className="w-full min-w-56" aria-label={props['aria-label']}>
        <SelectValue placeholder={props.placeholder} />
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          {props.special.map((s) => (
            <SelectItem key={s.value} value={s.value}>
              {s.label}
            </SelectItem>
          ))}
        </SelectGroup>
        {props.proxies.length > 0 && (
          <>
            <SelectSeparator />
            <SelectGroup>
              <SelectLabel>Свободные прокси</SelectLabel>
              {props.proxies.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {proxyLabel(p)}
                </SelectItem>
              ))}
            </SelectGroup>
          </>
        )}
      </SelectContent>
    </Select>
  )
}
```

`apps/web/src/components/codes/codes-table.tsx` — новый файл

```tsx
import { Link } from '@tanstack/react-router'
import { accountTitle, type CodeDto } from '@workspace/shared/accounts'
import { Badge } from '@workspace/ui/components/badge'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@workspace/ui/components/table'
import { formatDateTime, formatRelative } from '@/lib/format'
import { CopyCodeButton } from './copy-code-button'

/** Messages from @VerificationCodes, newest first. `showAccount` — for the shared feed. */
export function CodesTable({ items, showAccount, empty }: { items: CodeDto[]; showAccount?: boolean; empty: string }) {
  return (
    <div className="overflow-hidden rounded-lg border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Получен</TableHead>
            {showAccount && <TableHead>Аккаунт</TableHead>}
            <TableHead>Код</TableHead>
            <TableHead>Сообщение</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.length ? (
            items.map((c) => (
              <TableRow key={c.id}>
                <TableCell className="whitespace-nowrap" title={formatDateTime(c.date)}>
                  {formatRelative(c.date)}
                </TableCell>
                {showAccount && (
                  <TableCell>
                    <Link to="/accounts/$id" params={{ id: c.accountId }} className="hover:underline">
                      {accountTitle(c.account)}
                    </Link>
                  </TableCell>
                )}
                <TableCell>{c.code ? <CopyCodeButton code={c.code} /> : <Badge variant="outline">без кода</Badge>}</TableCell>
                <TableCell className="max-w-xl text-sm whitespace-pre-wrap">{c.text}</TableCell>
              </TableRow>
            ))
          ) : (
            <TableRow>
              <TableCell colSpan={showAccount ? 4 : 3} className="text-muted-foreground h-24 text-center">
                {empty}
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </div>
  )
}
```

`apps/web/src/components/codes/copy-code-button.tsx` — новый файл

```tsx
import { Button } from '@workspace/ui/components/button'
import { toast } from '@workspace/ui/components/toast'
import { CopyIcon } from 'lucide-react'

export function CopyCodeButton({ code }: { code: string }) {
  return (
    <Button
      variant="outline"
      size="sm"
      className="font-mono"
      aria-label={`Скопировать код ${code}`}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(code)
          toast.add({ title: 'Код скопирован', description: code })
        } catch {
          toast.add({ title: 'Не удалось скопировать', description: 'Браузер не дал доступ к буферу обмена' })
        }
      }}
    >
      {code}
      <CopyIcon data-icon="inline-end" />
    </Button>
  )
}
```

`apps/web/src/lib/accounts.ts` — новый файл

```ts
import { queryOptions } from '@tanstack/react-query'
import type { AccountDto, AccountSessionDto, AccountStatus, CodeDto } from '@workspace/shared/accounts'
import type { ProxyDto } from '@workspace/shared/proxies'
import { api } from './api'

export const accountsQueryOptions = queryOptions({
  queryKey: ['accounts'] as const,
  queryFn: ({ signal }) => api<{ items: AccountDto[] }>('/accounts', { signal }),
})

export const accountQueryOptions = (id: string) =>
  queryOptions({
    queryKey: ['accounts', id] as const,
    queryFn: ({ signal }) => api<AccountDto>(`/accounts/${id}`, { signal }),
  })

/** Asks the worker (and Telegram) — fetched only when the admin opens the list. */
export const accountSessionsQueryOptions = (id: string) =>
  queryOptions({
    queryKey: ['accounts', id, 'sessions'] as const,
    queryFn: ({ signal }) => api<{ items: AccountSessionDto[] }>(`/accounts/${id}/sessions`, { signal }),
    retry: false,
  })

export const codesQueryOptions = (accountId?: string) =>
  queryOptions({
    queryKey: ['codes', accountId ?? 'all'] as const,
    queryFn: ({ signal }) => api<{ items: CodeDto[] }>(`/codes?limit=100${accountId ? `&accountId=${accountId}` : ''}`, { signal }),
  })

export const accountStatusVariant: Record<AccountStatus, 'secondary' | 'outline' | 'destructive'> = {
  active: 'secondary',
  pending_check: 'outline',
  paused: 'outline',
  frozen: 'outline',
  proxy_down: 'destructive',
  error: 'destructive',
  unauthorized: 'destructive',
  banned: 'destructive',
}

export const ACCOUNT_STATUS_FILTERS = {
  all: null,
  active: ['active', 'frozen'],
  problems: ['proxy_down', 'error', 'unauthorized', 'banned'],
  other: ['pending_check', 'paused'],
} as const satisfies Record<string, readonly AccountStatus[] | null>
export type AccountStatusFilter = keyof typeof ACCOUNT_STATUS_FILTERS

/** Proxies an account may take: enabled, working or not yet checked, not used by another account. */
export function freeProxies(all: ProxyDto[], keepProxyId?: string | null): ProxyDto[] {
  return all.filter(
    (p) => p.id === keepProxyId || (p.disabledAt === null && p.account === null && (p.status === 'ok' || p.status === 'unchecked' || p.status === 'failing')),
  )
}

export function proxyLabel(p: Pick<ProxyDto, 'type' | 'host' | 'port' | 'tgCountry' | 'latencyMs'>): string {
  const extra = [p.tgCountry, p.latencyMs !== null ? `${p.latencyMs} мс` : null].filter(Boolean).join(', ')
  return `${p.type} ${p.host}:${p.port}${extra ? ` (${extra})` : ''}`
}
```

`apps/web/src/lib/app-events.ts` — новый файл

```ts
import * as React from 'react'
import type { AppEvent } from '@workspace/shared/events'

const EVENT_NAME = 'accs:event'

/** Re-broadcasts live-stream events inside the page, for components that care about one kind (QR login). */
export function emitAppEvent(event: AppEvent): void {
  window.dispatchEvent(new CustomEvent<AppEvent>(EVENT_NAME, { detail: event }))
}

export function useAppEvent(handler: (event: AppEvent) => void): void {
  const ref = React.useRef(handler)
  React.useEffect(() => {
    ref.current = handler
  })
  React.useEffect(() => {
    const listener = (e: Event) => ref.current((e as CustomEvent<AppEvent>).detail)
    window.addEventListener(EVENT_NAME, listener)
    return () => window.removeEventListener(EVENT_NAME, listener)
  }, [])
}
```

`apps/web/src/routes/_authed.tsx` — изменения

```diff
--- a/apps/web/src/routes/_authed.tsx
+++ b/apps/web/src/routes/_authed.tsx
@@ -2,6 +2,8 @@ import { useQueryClient } from '@tanstack/react-query'
 import { createFileRoute, Outlet, redirect } from '@tanstack/react-router'
 import { toast } from '@workspace/ui/components/toast'
 import { AppHeader } from '@/components/app-header'
+import { accountsQueryOptions } from '@/lib/accounts'
+import { emitAppEvent } from '@/lib/app-events'
 import { meQueryOptions, recheckSession } from '@/lib/auth'
 import { proxiesQueryOptions } from '@/lib/proxies'
 import { settingsQueryOptions } from '@/lib/settings'
@@ -26,6 +28,13 @@ function AuthedLayout() {
         if (event.by !== me.id) toast.add({ title: 'Настройки изменены', description: 'Другой админ или CLI обновил настройки.' })
       }
       if (event.type === 'proxies.changed') void queryClient.invalidateQueries({ queryKey: proxiesQueryOptions.queryKey })
+      // the list and the cards (['accounts', id]); sessions are re-read only on demand
+      if (event.type === 'accounts.changed') void queryClient.invalidateQueries({ queryKey: accountsQueryOptions.queryKey, predicate: (q) => q.queryKey[2] !== 'sessions' })
+      if (event.type === 'code.new') {
+        void queryClient.invalidateQueries({ queryKey: ['codes'] })
+        void queryClient.invalidateQueries({ queryKey: accountsQueryOptions.queryKey, predicate: (q) => q.queryKey[2] !== 'sessions' })
+      }
+      emitAppEvent(event)
     },
     // a revoked session ends at the global 401 handler (→ /login)
     onSessionLost: () => void recheckSession(queryClient),
```

`apps/web/src/routes/_authed/accounts.tsx` — удалить:

```bash
git rm apps/web/src/routes/_authed/accounts.tsx
```

`apps/web/src/routes/_authed/accounts/$id.tsx` — новый файл

```tsx
import * as React from 'react'
import { useMutation, useQuery, useQueryClient, useSuspenseQuery } from '@tanstack/react-query'
import { createFileRoute, Link } from '@tanstack/react-router'
import { accountTitle, FINAL_STATUSES, RUNNING_STATUSES, type AccountDto } from '@workspace/shared/accounts'
import { Alert, AlertDescription, AlertTitle } from '@workspace/ui/components/alert'
import { Badge } from '@workspace/ui/components/badge'
import { Button } from '@workspace/ui/components/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@workspace/ui/components/card'
import { toast } from '@workspace/ui/components/toast'
import { ArrowLeftIcon, PauseIcon, PlayIcon, RefreshCwIcon } from 'lucide-react'
import { AccountNotesForm } from '@/components/accounts/account-notes-form'
import { AccountRouteForm } from '@/components/accounts/account-route-form'
import { AccountSessions } from '@/components/accounts/account-sessions'
import { AccountStatusBadge } from '@/components/accounts/account-status-badge'
import { DeleteAccountDialog } from '@/components/accounts/delete-account-dialog'
import { CodesTable } from '@/components/codes/codes-table'
import { PageHeader } from '@/components/page-header'
import { ProxyStatusBadge } from '@/components/proxies/proxy-status-badge'
import { accountQueryOptions, accountsQueryOptions, codesQueryOptions } from '@/lib/accounts'
import { api, ApiError } from '@/lib/api'
import { formatDate, formatDateTime, formatRelative } from '@/lib/format'
import { pageTitle } from '@/lib/title'

export const Route = createFileRoute('/_authed/accounts/$id')({
  loader: ({ context, params }) => context.queryClient.query({ ...accountQueryOptions(params.id), staleTime: 'static' }),
  head: ({ loaderData }) => ({ meta: [{ title: pageTitle(loaderData ? accountTitle(loaderData) : 'Аккаунт', 'Аккаунты') }] }),
  component: AccountPage,
})

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[10rem_1fr] gap-2 py-1.5 text-sm">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </div>
  )
}

function ProfileCard({ a }: { a: AccountDto }) {
  const name = [a.firstName, a.lastName].filter(Boolean).join(' ')
  return (
    <Card>
      <CardHeader>
        <CardTitle>Профиль</CardTitle>
        <CardDescription>Обновляется из Telegram при подключении и раз в несколько часов.</CardDescription>
      </CardHeader>
      <CardContent>
        <dl className="divide-y">
          <Row label="Статус">
            <span className="flex flex-wrap items-center gap-2">
              <AccountStatusBadge status={a.status} />
              <span className="text-muted-foreground" title={formatDateTime(a.statusChangedAt)}>
                {formatRelative(a.statusChangedAt)}
              </span>
            </span>
          </Row>
          {a.statusReason && <Row label="Причина">{a.statusReason}</Row>}
          <Row label="Телефон">{a.phone ? `+${a.phone}` : '—'}</Row>
          <Row label="Имя">
            <span className="flex items-center gap-2">
              {name || '—'}
              {a.isPremium && <Badge variant="secondary">Premium</Badge>}
            </span>
          </Row>
          <Row label="Username">{a.username ? `@${a.username}` : '—'}</Row>
          <Row label="Telegram ID">
            <span className="font-mono">{a.tgUserId}</span>
          </Row>
          <Row label="Дата-центр">{a.dcId ? `DC${a.dcId}` : '—'}</Row>
          <Row label="На связи">
            <span title={formatDateTime(a.lastOkAt)}>{formatRelative(a.lastOkAt)}</span>
          </Row>
          <Row label="Добавлен">
            {formatDate(a.createdAt)} · {a.source === 'tdata' ? 'из tdata' : 'вход по QR'}
          </Row>
          <Row label="Устройство">
            {a.device.deviceModel}, {a.device.systemVersion}, {a.clientProfile === 'desktop' ? 'Telegram Desktop' : 'своё приложение'} {a.device.appVersion}
          </Row>
        </dl>
      </CardContent>
    </Card>
  )
}

function AccountPage() {
  const { id } = Route.useParams()
  const queryClient = useQueryClient()
  const { data: a } = useSuspenseQuery(accountQueryOptions(id))
  const codes = useQuery(codesQueryOptions(id))
  const running = RUNNING_STATUSES.includes(a.status)
  const final = FINAL_STATUSES.includes(a.status)

  const action = useMutation({
    mutationFn: (verb: 'pause' | 'resume' | 'reconnect') => api(`/accounts/${id}/${verb}`, { method: 'POST' }),
    onSuccess: async (_, verb) => {
      if (verb === 'reconnect') toast.add({ title: 'Переподключение запущено' })
      await queryClient.invalidateQueries({ queryKey: accountsQueryOptions.queryKey })
    },
    onError: (err) => toast.add({ title: 'Не получилось', description: err instanceof ApiError ? err.message : String(err) }),
  })

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Button variant="ghost" size="sm" render={<Link to="/accounts" />}>
          <ArrowLeftIcon data-icon="inline-start" />
          Аккаунты
        </Button>
      </div>
      <PageHeader
        title={accountTitle(a)}
        description={a.note ?? undefined}
        actions={
          <>
            {a.status === 'paused' ? (
              <Button variant="outline" disabled={action.isPending} onClick={() => action.mutate('resume')}>
                <PlayIcon data-icon="inline-start" />
                Возобновить
              </Button>
            ) : (
              <Button variant="outline" disabled={final || action.isPending} onClick={() => action.mutate('pause')}>
                <PauseIcon data-icon="inline-start" />
                Пауза
              </Button>
            )}
            <Button variant="outline" disabled={!running && a.status !== 'proxy_down'} onClick={() => action.mutate('reconnect')}>
              <RefreshCwIcon data-icon="inline-start" />
              Переподключить
            </Button>
            <DeleteAccountDialog account={a} />
          </>
        }
      />
      {a.status === 'frozen' && (
        <Alert>
          <AlertTitle>Аккаунт заморожен Telegram</AlertTitle>
          <AlertDescription>
            Коды продолжают приходить, но многие действия недоступны{a.frozenUntil ? ` до ${formatDate(a.frozenUntil)}` : ''}.
          </AlertDescription>
        </Alert>
      )}
      {final && (
        <Alert variant="destructive">
          <AlertTitle>{a.status === 'banned' ? 'Аккаунт заблокирован Telegram' : 'Сессия больше не действует'}</AlertTitle>
          <AlertDescription>
            {a.status === 'banned' ? 'Восстановить работу из панели нельзя.' : 'Её завершили на другом устройстве. Добавьте аккаунт заново из свежей tdata или по QR.'}
          </AlertDescription>
        </Alert>
      )}
      <div className="grid gap-6 lg:grid-cols-2">
        <ProfileCard a={a} />
        <div className="flex flex-col gap-6">
          <Card>
            <CardHeader>
              <CardTitle>Подключение</CardTitle>
              <CardDescription>
                {a.proxy ? (
                  <span className="flex flex-wrap items-center gap-2">
                    Сейчас: <span className="font-mono">{`${a.proxy.host}:${a.proxy.port}`}</span>
                    {a.proxy.tgCountry && <span>{a.proxy.tgCountry}</span>}
                    <ProxyStatusBadge status={a.proxy.status} />
                  </span>
                ) : a.connectionMode === 'direct' ? (
                  'Сейчас: напрямую, без прокси'
                ) : (
                  'Прокси не назначен — аккаунт ждёт'
                )}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <AccountRouteForm key={a.id} account={a} />
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Метка и заметка</CardTitle>
            </CardHeader>
            <CardContent>
              <AccountNotesForm key={a.id} account={a} />
            </CardContent>
          </Card>
        </div>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Активные сессии</CardTitle>
          <CardDescription>Устройства, на которых открыт этот аккаунт.</CardDescription>
        </CardHeader>
        <CardContent>
          <AccountSessions key={a.id} accountId={a.id} running={a.status === 'active' || a.status === 'frozen'} />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Коды</CardTitle>
          <CardDescription>Сообщения от @VerificationCodes, последние 100.</CardDescription>
        </CardHeader>
        <CardContent>
          {codes.data ? <CodesTable items={codes.data.items} empty="Кодов пока не было" /> : <p className="text-muted-foreground text-sm">Загрузка…</p>}
        </CardContent>
      </Card>
    </div>
  )
}
```

`apps/web/src/routes/_authed/accounts/index.tsx` — новый файл

```tsx
import * as React from 'react'
import { useMutation, useQueryClient, useSuspenseQuery } from '@tanstack/react-query'
import { createFileRoute, Link } from '@tanstack/react-router'
import { createColumnHelper } from '@tanstack/react-table'
import { accountTitle, type AccountDto } from '@workspace/shared/accounts'
import { Badge } from '@workspace/ui/components/badge'
import { Button } from '@workspace/ui/components/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@workspace/ui/components/dropdown-menu'
import { Field, FieldLabel } from '@workspace/ui/components/field'
import { Input } from '@workspace/ui/components/input'
import { toast } from '@workspace/ui/components/toast'
import { ToggleGroup, ToggleGroupItem } from '@workspace/ui/components/toggle-group'
import { MoreHorizontalIcon } from 'lucide-react'
import { AccountStatusBadge } from '@/components/accounts/account-status-badge'
import { AddAccountDialog } from '@/components/accounts/add-account-dialog'
import { DataTable, type ClientTableFeatures } from '@/components/data-table'
import { PageHeader } from '@/components/page-header'
import { ProxyStatusBadge } from '@/components/proxies/proxy-status-badge'
import { ACCOUNT_STATUS_FILTERS, accountsQueryOptions, type AccountStatusFilter } from '@/lib/accounts'
import { api, ApiError } from '@/lib/api'
import { formatDateTime, formatRelative } from '@/lib/format'
import { titleHead } from '@/lib/title'

export const Route = createFileRoute('/_authed/accounts/')({
  head: titleHead('Аккаунты'),
  loader: ({ context }) => context.queryClient.query({ ...accountsQueryOptions, staleTime: 'static' }),
  component: AccountsPage,
})

const col = createColumnHelper<ClientTableFeatures, AccountDto>()

function matches(a: AccountDto, query: string): boolean {
  if (!query) return true
  const q = query.toLowerCase().replace(/^\+/, '')
  return [a.label, a.phone, a.username, a.firstName, a.lastName, String(a.tgUserId), a.note].some((v) => v?.toLowerCase().includes(q))
}

function AccountsPage() {
  const queryClient = useQueryClient()
  const { data } = useSuspenseQuery(accountsQueryOptions)
  const [statusFilter, setStatusFilter] = React.useState<AccountStatusFilter>('all')
  const [query, setQuery] = React.useState('')

  const action = useMutation({
    mutationFn: ({ a, verb }: { a: AccountDto; verb: 'pause' | 'resume' | 'reconnect' }) => api(`/accounts/${a.id}/${verb}`, { method: 'POST' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: accountsQueryOptions.queryKey }),
    onError: (err) => toast.add({ title: 'Не получилось', description: err instanceof ApiError ? err.message : String(err) }),
  })

  const statuses = ACCOUNT_STATUS_FILTERS[statusFilter] as readonly string[] | null
  const rows = data.items.filter((a) => (!statuses || statuses.includes(a.status)) && matches(a, query))

  const columns = React.useMemo(
    () =>
      col.columns([
        col.display({
          id: 'account',
          header: 'Аккаунт',
          cell: ({ row }) => {
            const a = row.original
            const name = [a.firstName, a.lastName].filter(Boolean).join(' ')
            return (
              <Link to="/accounts/$id" params={{ id: a.id }} className="flex flex-col hover:underline">
                <span className="font-medium">{accountTitle(a)}</span>
                <span className="text-muted-foreground text-xs">{[name, a.username && `@${a.username}`].filter(Boolean).join(' · ') || `id ${a.tgUserId}`}</span>
              </Link>
            )
          },
        }),
        col.accessor('status', { header: 'Статус', cell: ({ row }) => <AccountStatusBadge status={row.original.status} reason={row.original.statusReason} /> }),
        col.accessor('proxy', {
          header: 'Прокси',
          cell: ({ row }) => {
            const p = row.original.proxy
            if (!p) return row.original.connectionMode === 'direct' ? <Badge variant="outline">напрямую</Badge> : <span className="text-muted-foreground">не назначен</span>
            return (
              <span className="flex items-center gap-2">
                <span className="font-mono text-xs">
                  {p.host}:{p.port}
                </span>
                {p.tgCountry && <span className="text-muted-foreground text-xs">{p.tgCountry}</span>}
                {p.status !== 'ok' && <ProxyStatusBadge status={p.status} />}
              </span>
            )
          },
        }),
        col.accessor('lastCodeAt', { header: 'Последний код', cell: (info) => <span title={formatDateTime(info.getValue())}>{formatRelative(info.getValue())}</span> }),
        col.accessor('lastOkAt', { header: 'На связи', cell: (info) => <span title={formatDateTime(info.getValue())} className="text-muted-foreground text-sm">{formatRelative(info.getValue())}</span> }),
        col.accessor('source', { header: 'Источник', cell: (info) => (info.getValue() === 'tdata' ? 'tdata' : 'QR') }),
        col.display({
          id: 'actions',
          header: () => <span className="sr-only">Действия</span>,
          cell: ({ row }) => {
            const a = row.original
            return (
              <DropdownMenu>
                <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label={`Действия: ${accountTitle(a)}`} />}>
                  <MoreHorizontalIcon />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuGroup>
                    <DropdownMenuItem render={<Link to="/accounts/$id" params={{ id: a.id }} />}>Открыть</DropdownMenuItem>
                    {a.status === 'paused' ? (
                      <DropdownMenuItem onClick={() => action.mutate({ a, verb: 'resume' })}>Возобновить</DropdownMenuItem>
                    ) : (
                      <DropdownMenuItem disabled={a.status === 'unauthorized' || a.status === 'banned'} onClick={() => action.mutate({ a, verb: 'pause' })}>
                        Пауза
                      </DropdownMenuItem>
                    )}
                    <DropdownMenuItem disabled={a.status === 'paused' || a.status === 'unauthorized' || a.status === 'banned'} onClick={() => action.mutate({ a, verb: 'reconnect' })}>
                      Переподключить
                    </DropdownMenuItem>
                  </DropdownMenuGroup>
                </DropdownMenuContent>
              </DropdownMenu>
            )
          },
        }),
      ]),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `action.mutate` is stable
    [],
  )

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Аккаунты" description="Telegram-аккаунты панели: перенесённые из tdata и вошедшие по QR." actions={<AddAccountDialog />} />
      <div className="flex flex-wrap items-end gap-4">
        <Field className="w-auto">
          <FieldLabel>Статус</FieldLabel>
          <ToggleGroup variant="outline" value={[statusFilter]} onValueChange={(v) => v[0] && setStatusFilter(v[0] as AccountStatusFilter)}>
            <ToggleGroupItem value="all">Все</ToggleGroupItem>
            <ToggleGroupItem value="active">Работают</ToggleGroupItem>
            <ToggleGroupItem value="problems">Проблемы</ToggleGroupItem>
            <ToggleGroupItem value="other">Остальные</ToggleGroupItem>
          </ToggleGroup>
        </Field>
        <Field className="w-64">
          <FieldLabel htmlFor="account-search">Поиск</FieldLabel>
          <Input id="account-search" placeholder="метка, телефон, @username, id" value={query} onChange={(e) => setQuery(e.target.value)} />
        </Field>
      </div>
      <DataTable columns={columns} data={rows} pageSize={50} empty={data.items.length ? 'Ничего не найдено' : 'Аккаунтов пока нет — добавьте из tdata или по QR'} />
    </div>
  )
}
```

- [ ] **Шаг 5: Перегенерировать дерево роутов**

```bash
fnm exec --using=26 pnpm --filter web exec vite build   # плагин TanStack Router обновит src/routeTree.gen.ts (или запущенный pnpm dev)
```

- [ ] **Шаг 6: Проверки**

```bash
fnm exec --using=26 pnpm typecheck
fnm exec --using=26 pnpm lint
fnm exec --using=26 npx vitest run --project web
# всё зелёное
```

- [ ] **Шаг 7: Коммит**

```bash
git add -A
git commit -F - <<'MSG'
feat(web): accounts list, account card, tdata import and QR login dialogs
MSG
```

---

### Task 17: Web: лента кодов

Главная «Коды»: лента всех аккаунтов (или одного — `?account=<id>` в URL), «Показать ещё» по курсору (`useInfiniteQuery`, страница 50), копирование кода, метка «новый» у кодов, пришедших при открытой странице; из карточки аккаунта — «В ленте кодов». Тест маршрутов из плана 1 получает реалистичные ответы API (списки — массивы).

**Files:**
- Modify: `apps/web/src/components/codes/codes-table.tsx`
- Modify: `apps/web/src/lib/accounts.ts`
- Modify: `apps/web/src/routes/_authed/accounts/$id.tsx`
- Modify: `apps/web/src/routes/_authed/index.tsx`
- Test (modify): `apps/web/src/routes/auth-guard.test.tsx`
- Test: `apps/web/src/routes/codes-feed.test.tsx`

**Interfaces:**
- Consumes: `CodesTable`, `codesQueryOptions` (задача 16); `GET /api/codes` (задача 12).
- Produces:
  - `apps/web/src/components/codes/codes-table.tsx`: `CodesTable({ items, showAccount, empty, fresh }: { items: CodeDto[]; showAccount?: boolean; empty: string; fresh?: ReadonlySet<number> })`
  - `apps/web/src/lib/accounts.ts`: `CODES_PAGE_SIZE`; `codesFeedQueryOptions`

- [ ] **Шаг 1: Написать падающий тест**

`apps/web/src/routes/auth-guard.test.tsx` — изменения

```diff
--- a/apps/web/src/routes/auth-guard.test.tsx
+++ b/apps/web/src/routes/auth-guard.test.tsx
@@ -8,6 +8,13 @@ import { handleUnauthorized } from '@/lib/session'
 
 const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
 
+/** API of a signed-in admin with nothing configured yet: settings are a map, every list is empty. */
+const signedIn = (url: string) => {
+  if (url.endsWith('/auth/me')) return json({ id: 'a1', login: 'root' })
+  if (url.endsWith('/settings')) return json({ items: {} })
+  return json({ items: [] })
+}
+
 function setup(path: string) {
   const queryClient = createQueryClient(() => handleUnauthorized(queryClient, router))
   const router = createAppRouter(queryClient, createMemoryHistory({ initialEntries: [path] }))
@@ -70,7 +77,7 @@ it('redirects anonymous users to /login and keeps the target', async () => {
 
 it('renders the shell with the active tab for signed-in admins', async () => {
   vi.stubGlobal('EventSource', SilentEventSource)
-  vi.stubGlobal('fetch', vi.fn(async (url: string) => (url.endsWith('/auth/me') ? json({ id: 'a1', login: 'root' }) : json({ items: {} }))))
+  vi.stubGlobal('fetch', vi.fn(async (url: string) => (signedIn(url))))
   setup('/')
   expect(await screen.findByRole('heading', { name: 'Коды' })).toBeInTheDocument()
   expect(screen.getAllByRole('tab', { name: 'Коды' })[0]).toHaveAttribute('aria-selected', 'true')
@@ -84,7 +91,7 @@ it('returns to /login when the session is revoked while browsing', async () => {
     'fetch',
     vi.fn(async (url: string) => {
       if (revoked) return json({ error: 'unauthorized' }, 401)
-      return url.endsWith('/auth/me') ? json({ id: 'a1', login: 'root' }) : json({ items: {} })
+      return signedIn(url)
     }),
   )
   const { router, queryClient } = setup('/')
@@ -100,7 +107,7 @@ async function signedInWithStream() {
   const state = { revoked: false }
   const fetchMock = vi.fn(async (url: string) => {
     if (state.revoked) return json({ error: 'unauthorized' }, 401)
-    return url.endsWith('/auth/me') ? json({ id: 'a1', login: 'root' }) : json({ items: {} })
+    return signedIn(url)
   })
   vi.stubGlobal('fetch', fetchMock)
   const { router } = setup('/')
@@ -148,7 +155,7 @@ it('shows an error screen with a retry instead of a blank page when the API is d
   vi.stubGlobal('EventSource', SilentEventSource)
   vi.stubGlobal('fetch', vi.fn(async (url: string) => {
     if (!up) return json({ error: 'internal' }, 502)
-    return url.endsWith('/auth/me') ? json({ id: 'a1', login: 'root' }) : json({ items: {} })
+    return signedIn(url)
   }))
   setup('/')
   expect(await screen.findByText('Не удалось загрузить страницу')).toBeInTheDocument()
@@ -159,7 +166,7 @@ it('shows an error screen with a retry instead of a blank page when the API is d
 
 it('shows «not found» for an unknown address', async () => {
   vi.stubGlobal('EventSource', SilentEventSource)
-  vi.stubGlobal('fetch', vi.fn(async (url: string) => (url.endsWith('/auth/me') ? json({ id: 'a1', login: 'root' }) : json({ items: {} }))))
+  vi.stubGlobal('fetch', vi.fn(async (url: string) => (signedIn(url))))
   setup('/no-such-page')
   expect(await screen.findByText('Страница не найдена')).toBeInTheDocument()
   expect(screen.getByRole('button', { name: 'На главную' })).toHaveAttribute('href', '/')
```

`apps/web/src/routes/codes-feed.test.tsx` — новый файл

```tsx
import { QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, RouterProvider } from '@tanstack/react-router'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { CodeDto } from '@workspace/shared/accounts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createQueryClient } from '@/lib/query-client'
import { createAppRouter } from '@/lib/router'
import { accountFixture } from '@/test/fixtures'
import { json } from '@/test/render'

/** EventSource the test drives by hand. */
class FakeEventSource extends EventTarget {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSED = 2
  static last: FakeEventSource | null = null
  readyState = 1
  onerror: (() => void) | null = null
  constructor() {
    super()
    FakeEventSource.last = this
  }
  close() {}
  emit(type: string, data: unknown = {}) {
    this.dispatchEvent(new MessageEvent(type, { data: JSON.stringify(data) }))
  }
}

const A1 = accountFixture()
const A2 = accountFixture({ id: '00000000-0000-4000-8000-0000000000a2', tgUserId: 7_000_002, phone: '77007654321', label: 'Второй' })

const code = (id: number, over: Partial<CodeDto> = {}): CodeDto => ({
  id,
  accountId: A1.id,
  account: { label: null, phone: A1.phone, username: null },
  tgMessageId: id,
  date: new Date(Date.now() - (1000 - id) * 60_000).toISOString(),
  text: `Your code: ${100000 + id}`,
  code: String(100000 + id),
  notifiedAt: null,
  ...over,
})

afterEach(() => vi.unstubAllGlobals())

function setup(path: string, codes: (params: URLSearchParams) => CodeDto[]) {
  vi.stubGlobal('EventSource', FakeEventSource)
  const fetchMock = vi.fn(async (url: string) => {
    const u = new URL(url, 'http://panel.test')
    if (u.pathname === '/api/auth/me') return json({ id: 'a1', login: 'root' })
    if (u.pathname === '/api/settings') return json({ items: {} })
    if (u.pathname === '/api/accounts') return json({ items: [A1, A2] })
    if (u.pathname === '/api/codes') return json({ items: codes(u.searchParams) })
    return json({ items: [] })
  })
  vi.stubGlobal('fetch', fetchMock)
  const queryClient = createQueryClient()
  const router = createAppRouter(queryClient, createMemoryHistory({ initialEntries: [path] }))
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
  return { router, fetchMock }
}

const codesCalls = (fetchMock: ReturnType<typeof vi.fn>) =>
  fetchMock.mock.calls.map(([url]) => new URL(String(url), 'http://panel.test')).filter((u) => u.pathname === '/api/codes')

describe('codes feed', () => {
  it('shows codes of all accounts with a copy button and pages back with «Показать ещё»', async () => {
    // 50 on the first page (a full page), 1 older on the second
    const { fetchMock } = setup('/', (p) => (p.get('before') ? [code(1)] : Array.from({ length: 50 }, (_, i) => code(100 - i))))
    expect(await screen.findByRole('button', { name: 'Скопировать код 100100' })).toBeInTheDocument()
    expect(screen.getAllByRole('link', { name: '+77001234567' }).length).toBeGreaterThan(0)

    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Показать ещё' }))
    expect(await screen.findByRole('button', { name: 'Скопировать код 100001' })).toBeInTheDocument()
    expect(codesCalls(fetchMock).at(-1)!.searchParams.get('before')).toBe('51')
    // a short page is the last one
    expect(screen.queryByRole('button', { name: 'Показать ещё' })).not.toBeInTheDocument()
  })

  it('filters by account through the URL', async () => {
    const { fetchMock, router } = setup(`/?account=${A2.id}`, () => [code(5, { accountId: A2.id, account: { label: 'Второй', phone: A2.phone, username: null } })])
    expect(await screen.findByRole('button', { name: 'Скопировать код 100005' })).toBeInTheDocument()
    expect(codesCalls(fetchMock).at(-1)!.searchParams.get('accountId')).toBe(A2.id)
    expect(screen.getByLabelText('Аккаунт')).toHaveTextContent('Второй')
    expect(router.state.location.search).toEqual({ account: A2.id })
  })

  it('a new code arrives live and is marked', async () => {
    let list = [code(10)]
    setup('/', () => list)
    expect(await screen.findByRole('button', { name: 'Скопировать код 100010' })).toBeInTheDocument()
    act(() => FakeEventSource.last!.emit('ready'))

    list = [code(11), code(10)]
    act(() => FakeEventSource.last!.emit('code.new', { type: 'code.new', id: 11, accountId: A1.id, code: '100011', date: new Date().toISOString() }))
    const row = (await screen.findByRole('button', { name: 'Скопировать код 100011' })).closest('tr')!
    expect(within(row).getByText('новый')).toBeInTheDocument()
    await waitFor(() => expect(screen.getAllByText('новый')).toHaveLength(1))
  })

  it('copies a code to the clipboard', async () => {
    setup('/', () => [code(7)])
    const user = userEvent.setup()
    const writeText = vi.spyOn(navigator.clipboard, 'writeText')
    await user.click(await screen.findByRole('button', { name: 'Скопировать код 100007' }))
    expect(writeText).toHaveBeenCalledWith('100007')
  })
})
```

- [ ] **Шаг 2: Убедиться, что тест падает**

```bash
fnm exec --using=26 npx vitest run --project web apps/web/src/routes/codes-feed.test.tsx
# FAIL: нет кнопок «Скопировать код …» на главной
```

- [ ] **Шаг 3: Реализация**

`apps/web/src/components/codes/codes-table.tsx` — изменения

```diff
--- a/apps/web/src/components/codes/codes-table.tsx
+++ b/apps/web/src/components/codes/codes-table.tsx
@@ -6,7 +6,7 @@ import { formatDateTime, formatRelative } from '@/lib/format'
 import { CopyCodeButton } from './copy-code-button'
 
 /** Messages from @VerificationCodes, newest first. `showAccount` — for the shared feed. */
-export function CodesTable({ items, showAccount, empty }: { items: CodeDto[]; showAccount?: boolean; empty: string }) {
+export function CodesTable({ items, showAccount, empty, fresh }: { items: CodeDto[]; showAccount?: boolean; empty: string; fresh?: ReadonlySet<number> }) {
   return (
     <div className="overflow-hidden rounded-lg border">
       <Table>
@@ -23,7 +23,10 @@ export function CodesTable({ items, showAccount, empty }: { items: CodeDto[]; sh
             items.map((c) => (
               <TableRow key={c.id}>
                 <TableCell className="whitespace-nowrap" title={formatDateTime(c.date)}>
-                  {formatRelative(c.date)}
+                  <span className="flex items-center gap-2">
+                    {formatRelative(c.date)}
+                    {fresh?.has(c.id) && <Badge>новый</Badge>}
+                  </span>
                 </TableCell>
                 {showAccount && (
                   <TableCell>
```

`apps/web/src/lib/accounts.ts` — изменения

```diff
--- a/apps/web/src/lib/accounts.ts
+++ b/apps/web/src/lib/accounts.ts
@@ -1,4 +1,4 @@
-import { queryOptions } from '@tanstack/react-query'
+import { infiniteQueryOptions, queryOptions } from '@tanstack/react-query'
 import type { AccountDto, AccountSessionDto, AccountStatus, CodeDto } from '@workspace/shared/accounts'
 import type { ProxyDto } from '@workspace/shared/proxies'
 import { api } from './api'
@@ -28,6 +28,22 @@ export const codesQueryOptions = (accountId?: string) =>
     queryFn: ({ signal }) => api<{ items: CodeDto[] }>(`/codes?limit=100${accountId ? `&accountId=${accountId}` : ''}`, { signal }),
   })
 
+export const CODES_PAGE_SIZE = 50
+
+/** The codes feed: newest first, «показать ещё» pages back by id. */
+export const codesFeedQueryOptions = (accountId?: string) =>
+  infiniteQueryOptions({
+    queryKey: ['codes', accountId ?? 'all', 'feed'] as const,
+    queryFn: ({ pageParam, signal }) => {
+      const params = new URLSearchParams({ limit: String(CODES_PAGE_SIZE) })
+      if (accountId) params.set('accountId', accountId)
+      if (pageParam) params.set('before', String(pageParam))
+      return api<{ items: CodeDto[] }>(`/codes?${params}`, { signal })
+    },
+    initialPageParam: null as number | null,
+    getNextPageParam: (last) => (last.items.length === CODES_PAGE_SIZE ? last.items.at(-1)!.id : null),
+  })
+
 export const accountStatusVariant: Record<AccountStatus, 'secondary' | 'outline' | 'destructive'> = {
   active: 'secondary',
   pending_check: 'outline',
```

`apps/web/src/routes/_authed/accounts/$id.tsx` — изменения

```diff
--- a/apps/web/src/routes/_authed/accounts/$id.tsx
+++ b/apps/web/src/routes/_authed/accounts/$id.tsx
@@ -5,7 +5,7 @@ import { accountTitle, FINAL_STATUSES, RUNNING_STATUSES, type AccountDto } from
 import { Alert, AlertDescription, AlertTitle } from '@workspace/ui/components/alert'
 import { Badge } from '@workspace/ui/components/badge'
 import { Button } from '@workspace/ui/components/button'
-import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@workspace/ui/components/card'
+import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@workspace/ui/components/card'
 import { toast } from '@workspace/ui/components/toast'
 import { ArrowLeftIcon, PauseIcon, PlayIcon, RefreshCwIcon } from 'lucide-react'
 import { AccountNotesForm } from '@/components/accounts/account-notes-form'
@@ -102,7 +102,7 @@ function AccountPage() {
   return (
     <div className="flex flex-col gap-6">
       <div>
-        <Button variant="ghost" size="sm" render={<Link to="/accounts" />}>
+        <Button variant="ghost" size="sm" render={<Link to="/accounts" />} nativeButton={false}>
           <ArrowLeftIcon data-icon="inline-start" />
           Аккаунты
         </Button>
@@ -194,6 +194,11 @@ function AccountPage() {
         <CardHeader>
           <CardTitle>Коды</CardTitle>
           <CardDescription>Сообщения от @VerificationCodes, последние 100.</CardDescription>
+          <CardAction>
+            <Button variant="outline" size="sm" render={<Link to="/" search={{ account: a.id }} />} nativeButton={false}>
+              В ленте кодов
+            </Button>
+          </CardAction>
         </CardHeader>
         <CardContent>
           {codes.data ? <CodesTable items={codes.data.items} empty="Кодов пока не было" /> : <p className="text-muted-foreground text-sm">Загрузка…</p>}
```

`apps/web/src/routes/_authed/index.tsx` — заменить содержимое целиком

```tsx
import * as React from 'react'
import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { createFileRoute, Link } from '@tanstack/react-router'
import { accountTitle } from '@workspace/shared/accounts'
import { Button } from '@workspace/ui/components/button'
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@workspace/ui/components/empty'
import { Field, FieldLabel } from '@workspace/ui/components/field'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@workspace/ui/components/select'
import { Spinner } from '@workspace/ui/components/spinner'
import { KeyRoundIcon } from 'lucide-react'
import { z } from 'zod'
import { CodesTable } from '@/components/codes/codes-table'
import { PageHeader } from '@/components/page-header'
import { SetupAlert } from '@/components/setup-alert'
import { accountsQueryOptions, codesFeedQueryOptions } from '@/lib/accounts'
import { useAppEvent } from '@/lib/app-events'
import { titleHead } from '@/lib/title'

export const Route = createFileRoute('/_authed/')({
  head: titleHead('Коды'),
  validateSearch: z.object({ account: z.uuid().optional().catch(undefined) }),
  component: CodesPage,
})

function CodesPage() {
  const { account } = Route.useSearch()
  const navigate = Route.useNavigate()
  const accounts = useQuery(accountsQueryOptions)
  const feed = useInfiniteQuery(codesFeedQueryOptions(account))
  // codes that arrived while the page is open get a «новый» mark; the list itself refetches on `code.new`
  const [fresh, setFresh] = React.useState<ReadonlySet<number>>(new Set())
  useAppEvent((event) => {
    if (event.type === 'code.new') setFresh((prev) => new Set(prev).add(event.id))
  })

  const accountItems = [
    { label: 'Все аккаунты', value: null as string | null },
    ...(accounts.data?.items ?? []).map((a) => ({ label: accountTitle(a), value: a.id as string | null })),
  ]
  const items = feed.data?.pages.flatMap((p) => p.items) ?? []

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Коды" description="Сообщения от @VerificationCodes всех аккаунтов — новые появляются без перезагрузки страницы." />
      <SetupAlert />
      {accounts.data?.items.length === 0 ? (
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <KeyRoundIcon />
            </EmptyMedia>
            <EmptyTitle>Кодов пока нет</EmptyTitle>
            <EmptyDescription>Как только появятся аккаунты, новые коды будут приходить сюда без перезагрузки страницы.</EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button variant="outline" render={<Link to="/accounts" />} nativeButton={false}>
              К аккаунтам
            </Button>
          </EmptyContent>
        </Empty>
      ) : (
        <>
          <div className="flex flex-wrap items-end gap-4">
            <Field className="w-64">
              <FieldLabel htmlFor="codes-account">Аккаунт</FieldLabel>
              <Select items={accountItems} value={account ?? null} onValueChange={(v) => void navigate({ search: v ? { account: v } : {} })}>
                <SelectTrigger id="codes-account" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {accountItems.map((item) => (
                      <SelectItem key={item.value ?? 'all'} value={item.value}>
                        {item.label}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </Field>
          </div>
          {feed.isPending ? (
            <Spinner />
          ) : (
            <CodesTable items={items} showAccount={!account} fresh={fresh} empty={account ? 'У этого аккаунта кодов пока не было' : 'Кодов пока не было'} />
          )}
          {feed.hasNextPage && (
            <div className="flex justify-center">
              <Button variant="outline" disabled={feed.isFetchingNextPage} onClick={() => void feed.fetchNextPage()}>
                {feed.isFetchingNextPage && <Spinner data-icon="inline-start" />}
                Показать ещё
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  )
}
```

- [ ] **Шаг 4: Перегенерировать дерево роутов**

```bash
fnm exec --using=26 pnpm --filter web exec vite build   # плагин TanStack Router обновит src/routeTree.gen.ts (или запущенный pnpm dev)
```

- [ ] **Шаг 5: Проверки**

```bash
fnm exec --using=26 pnpm typecheck
fnm exec --using=26 pnpm lint
fnm exec --using=26 npx vitest run --project web
# всё зелёное
```

- [ ] **Шаг 6: Коммит**

```bash
git add -A
git commit -F - <<'MSG'
feat(web): live codes feed with account filter, paging and copy
MSG
```

---

### Task 18: Деплой, e2e, документация

`/api/healthz` отдаёт `workerVersion` из heartbeat; deploy-job ждёт, пока и `version`, и `workerVersion` равны коммиту — значит, новый воркер поднялся. e2e без Telegram: прокси вручную и удаление, отказ импорта не-zip, QR без своего api_id (и разделы «Аккаунты»/«Прокси» в навигации). В e2e тосты — тоже `role=dialog`, диалоги ищутся по имени. AGENTS.md и `deploy/README.md` — воркер, Telegram, правило «один auth key — одно место».

**Files:**
- Modify: `apps/api/src/routes/health.ts`
- Test (modify): `apps/api/test/app.test.ts`
- Test (modify): `e2e/smoke.spec.ts`
- Test: `e2e/telegram.spec.ts`
- Modify: `.github/workflows/ci.yml`
- Modify: `deploy/README.md`
- Modify: `AGENTS.md`

**Interfaces:**
- Consumes: `readWorkerHeartbeat` (задача 4); всё UI (задачи 8, 16, 17).

- [ ] **Шаг 1: Написать падающий тест**

`apps/api/test/app.test.ts` — изменения

```diff
--- a/apps/api/test/app.test.ts
+++ b/apps/api/test/app.test.ts
@@ -13,13 +13,13 @@ describe('app shell', () => {
   it('reports health of Postgres and Redis', async () => {
     const res = await send(ta.app, '/api/healthz')
     expect(res.status).toBe(200)
-    expect(await res.json()).toEqual({ ok: true, version: 'dev', worker: 'down' })
+    expect(await res.json()).toEqual({ ok: true, version: 'dev', worker: 'down', workerVersion: null })
   })
 
-  it('reports the worker as up while its heartbeat is fresh', async () => {
-    await ta.deps.redis.set('accs:worker:heartbeat', JSON.stringify({ at: new Date().toISOString(), pid: 1, version: 'dev' }), 'PX', 5_000)
+  it('reports the worker and its version while its heartbeat is fresh', async () => {
+    await ta.deps.redis.set('accs:worker:heartbeat', JSON.stringify({ at: new Date().toISOString(), pid: 1, version: 'abc1234' }), 'PX', 5_000)
     try {
-      expect(await (await send(ta.app, '/api/healthz')).json()).toMatchObject({ worker: 'ok' })
+      expect(await (await send(ta.app, '/api/healthz')).json()).toMatchObject({ worker: 'ok', workerVersion: 'abc1234' })
     } finally {
       await ta.deps.redis.del('accs:worker:heartbeat')
     }
```

`e2e/smoke.spec.ts` — изменения

```diff
--- a/e2e/smoke.spec.ts
+++ b/e2e/smoke.spec.ts
@@ -17,7 +17,7 @@ test('deep link survives the login redirect', async ({ page }) => {
 
 test('navigates between sections', async ({ page, isMobile }) => {
   await signIn(page)
-  for (const section of ['Аудит', 'Админы', 'Настройки', 'Коды']) await goToSection(page, section, isMobile)
+  for (const section of ['Аккаунты', 'Прокси', 'Аудит', 'Админы', 'Настройки', 'Коды']) await goToSection(page, section, isMobile)
 })
 
 test('saves a setting, keeps it after reload, resets it back', async ({ page, isMobile }) => {
```

`e2e/telegram.spec.ts` — новый файл

```ts
import { expect, test } from '@playwright/test'
import { goToSection, signIn } from './fixtures'

// No Telegram in CI: these check the panel side of proxies, tdata import and QR login up to the first call out.

test('adds a proxy by hand, then deletes it', async ({ page, isMobile }) => {
  const host = `e2e-${Date.now().toString(36)}.example`
  await signIn(page)
  await goToSection(page, 'Прокси', isMobile)
  await page.getByRole('button', { name: 'Добавить', exact: true }).click()
  // toasts are dialogs too: pick the form by its title
  const dialog = page.getByRole('dialog', { name: 'Новый прокси' })
  await dialog.getByLabel('Адрес').fill(host)
  await dialog.getByLabel('Порт').fill('1080')
  await dialog.getByRole('button', { name: 'Добавить', exact: true }).click()
  await expect(dialog).toBeHidden()

  const row = page.getByRole('row').filter({ hasText: host })
  await expect(row).toBeVisible()
  await row.getByRole('button', { name: `Действия: ${host}:1080` }).click()
  await page.getByRole('menuitem', { name: 'Удалить' }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: 'Удалить' }).click()
  await expect(row).toHaveCount(0)
})

test('tdata import refuses a file that is not a zip', async ({ page, isMobile }) => {
  await signIn(page)
  await goToSection(page, 'Аккаунты', isMobile)
  await page.getByRole('button', { name: 'Добавить аккаунт' }).click()
  const dialog = page.getByRole('dialog', { name: 'Новый аккаунт' })
  await dialog.getByLabel('Архив tdata (.zip)').setInputFiles({ name: 'tdata.zip', mimeType: 'application/zip', buffer: Buffer.from('not a zip at all') })
  await dialog.getByRole('button', { name: 'Загрузить и проверить' }).click()
  await expect(dialog.getByText('Не удалось распаковать архив — это точно zip?')).toBeVisible()
})

test('QR login explains that it needs an own api_id', async ({ page, isMobile }) => {
  await signIn(page)
  await goToSection(page, 'Аккаунты', isMobile)
  await page.getByRole('button', { name: 'Добавить аккаунт' }).click()
  const dialog = page.getByRole('dialog', { name: 'Новый аккаунт' })
  await dialog.getByRole('tab', { name: 'По QR-коду' }).click()
  // «напрямую» is never preselected; the request fails before any connection to Telegram anyway
  await dialog.getByLabel('Подключение').click()
  await page.getByRole('option', { name: 'Напрямую, без прокси' }).click()
  await dialog.getByRole('button', { name: 'Показать QR-код' }).click()
  await expect(dialog.getByText('Для входа по QR нужен свой api_id и api_hash (Настройки → Telegram)')).toBeVisible()
})
```

- [ ] **Шаг 2: Убедиться, что тест падает**

```bash
fnm exec --using=26 npx vitest run --project api apps/api/test/app.test.ts
# FAIL: в ответе healthz нет workerVersion
```

- [ ] **Шаг 3: Реализация**

`apps/api/src/routes/health.ts` — изменения

```diff
--- a/apps/api/src/routes/health.ts
+++ b/apps/api/src/routes/health.ts
@@ -10,9 +10,9 @@ export const healthRoutes = new Hono<AppEnv>().get('/healthz', async (c) => {
   try {
     await db.execute(sql`select 1`)
     await redis.ping()
-    // reported, not judged: the api stays healthy while the worker restarts
-    const worker = (await readWorkerHeartbeat(redis)) ? 'ok' : 'down'
-    return c.json({ ok: true, version, worker })
+    // reported, not judged: the api stays healthy while the worker restarts; CI waits for both versions
+    const heartbeat = await readWorkerHeartbeat(redis)
+    return c.json({ ok: true, version, worker: heartbeat ? 'ok' : 'down', workerVersion: heartbeat?.version ?? null })
   } catch {
     return c.json({ ok: false, version }, 503)
   }
```

`.github/workflows/ci.yml` — изменения

```diff
--- a/.github/workflows/ci.yml
+++ b/.github/workflows/ci.yml
@@ -148,10 +148,12 @@ jobs:
           printf '%s\n' "$GHCR_TOKEN" | ssh -i ~/.ssh/deploy_key -o IdentitiesOnly=yes -o BatchMode=yes "accs-deploy@$DEPLOY_HOST" "deploy $GITHUB_SHA"
       - name: Wait for panel.159.team to serve the new version
         run: |
+          # both the api and the worker (its Redis heartbeat) must run the new commit
           for _ in $(seq 1 36); do
-            version=$(curl -fsS --max-time 5 https://panel.159.team/api/healthz | jq -r .version || true)
-            if [ "$version" = "$GITHUB_SHA" ]; then echo "live: $version"; exit 0; fi
+            health=$(curl -fsS --max-time 5 https://panel.159.team/api/healthz || true)
+            versions=$(printf '%s' "$health" | jq -r '"\(.version) \(.workerVersion)"' 2>/dev/null || true)
+            if [ "$versions" = "$GITHUB_SHA $GITHUB_SHA" ]; then echo "live: api and worker at $GITHUB_SHA"; exit 0; fi
             sleep 5
           done
-          echo "panel.159.team still reports ${version:-nothing}, expected $GITHUB_SHA" >&2
+          echo "panel.159.team reports api/worker ${versions:-nothing}, expected $GITHUB_SHA" >&2
           exit 1
```

`deploy/README.md` — изменения

```diff
--- a/deploy/README.md
+++ b/deploy/README.md
@@ -6,9 +6,11 @@
    `ghcr.io/nokimaro/accs-manager:<sha>` и `:main`.
 2. **deploy** (GitHub environment `production`, только ветка `main`) заходит по SSH на сервер ключом,
    который умеет ровно одно — `deploy <sha>` (forced command `deploy-ssh`), и затем ждёт, пока
-   `https://panel.159.team/api/healthz` вернёт `version` = этот коммит.
+   `https://panel.159.team/api/healthz` вернёт `version` и `workerVersion` = этот коммит.
 3. На сервере `deploy-ssh` проверяет, что коммит есть в `origin/main`, переключает клон репозитория на него
-   и запускает `deploy.sh`: `docker compose pull` → `up -d --wait` (сначала миграции `accs-migrate`, затем `accs-api`).
+   и запускает `deploy.sh`: `docker compose pull` → `up -d --wait` (сначала миграции `accs-migrate`, затем `accs-api`
+   и `accs-worker`). Старый воркер останавливается до старта нового (graceful, до 30 с): два воркера никогда не держат
+   одни и те же Telegram-сессии, а advisory lock в БД страхует от второго экземпляра.
 
 ## Сервер
 
@@ -31,7 +33,11 @@ Staging-бокс HOSTKEY (Ubuntu 24.04), общий с p2c — их контей
 20242 — p2c-pgon, 20243 — наш.
 
 **`APP_ENCRYPTION_KEY` храните отдельно от дампов БД** (менеджер паролей): без него зашифрованные настройки
-(токен бота, api_hash, ключ proxy-store) не восстановить.
+(токен бота, api_hash, ключ proxy-store) и auth keys Telegram-аккаунтов (`account_auth`) не восстановить —
+аккаунты придётся добавлять заново.
+
+**Воркер упал или `worker: down`:** `docker logs accs-worker`; `docker restart accs-worker`. Пока воркер лежит,
+API работает, но коды не собираются и прокси не проверяются; после старта он догружает пропущенные коды.
 
 ## Частые действия
 
@@ -41,6 +47,8 @@ cd /opt/accs-manager
 cat deployed-sha
 sudo -u accs-deploy docker compose --project-directory repo -f repo/compose.yml -f repo/compose.prod.yml --env-file .env ps
 docker logs --tail 100 accs-api
+docker logs --tail 100 accs-worker      # «accounts: connected», «codes: watching @VerificationCodes»
+curl -s http://127.0.0.1:3300/api/healthz   # worker: ok|down, workerVersion
 
 # админ (пароль — из stdin, в историю shell не попадает)
 docker exec -i accs-api node apps/api/src/cli.ts admin:create --login <login> --password-stdin
```

`AGENTS.md` — изменения

````diff
--- a/AGENTS.md
+++ b/AGENTS.md
@@ -17,6 +17,10 @@ Telegram-канал через бота, пул прокси (прокси на
   `prod-app-encryption-key` (резервная копия `APP_ENCRYPTION_KEY` прода). Не печатать, не коммитить.
 - **`tdata-samples/`** содержит живой auth key владельца: не открывать в логах, не печатать байты ключей,
   не коммитить (в `.gitignore`).
+- **Один auth key — одно место.** Сессию аккаунта нельзя одновременно держать подключённой в двух местах
+  (прод, песочница, локальный dev, исходный Telegram Desktop): Telegram отзовёт её (`AUTH_KEY_DUPLICATED`).
+  Перед импортом той же tdata в другое место — пауза или удаление аккаунта там. Удаление «без выхода» только
+  перестаёт пользоваться ключом; «с выходом» (`?logout=true`) завершает сессию в Telegram и для владельца.
 - **Пуш в `main` = деплой в прод.** Перед пушем: `pnpm lint`, `pnpm typecheck`, `pnpm test`, для изменений UI —
   e2e (`E2E_BASE_URL=http://localhost:5173 pnpm e2e` против dev). Проверить дифф на секреты. После пуша — следить
   за прогоном (`gh run watch`). Крупную работу — через ветку. Коммиты, меняющие только `docs/**` и `*.md`,
@@ -32,19 +36,24 @@ Telegram-канал через бота, пул прокси (прокси на
 Node 26 (TypeScript исполняется напрямую — type stripping, без сборки api), pnpm 12.8.2 + Turborepo, TypeScript 6,
 Hono 4 (+ @hono/node-server), Drizzle ORM 0.45 + drizzle-kit, PostgreSQL 18, Redis 8 (ioredis), pino 10, Zod 4,
 React 19 + Vite 8, TanStack Router (file-based, autoCodeSplitting) / Query 5 / Table, shadcn (Base UI, Tailwind 4,
-`cn` из пакета `cn`), Vitest 5 + testcontainers, Playwright. Telegram (планы 2–3): mtcute 0.32 (`@mtcute/node`,
-`@mtcute/convert` для tdata).
+`cn` из пакета `cn`), Vitest 5 + testcontainers, Playwright. Воркер: BullMQ 6 (очереди в Redis). Telegram:
+mtcute 0.32.3 — `@mtcute/node` (клиент, http/socks-транспорты), `@mtcute/convert` (tdata → string session),
+`@mtcute/postgres` (хранилище в схеме `mtcute`), QR-код в браузере — `qrcode`.
 
 ## Структура
 
 ```
 apps/api        Hono API + CLI (src/main.ts, src/app.ts, src/cli.ts; routes/, middleware/{origin,auth,audit}, lib/, services/)
+apps/worker     воркер: lock.ts (advisory lock), runtime.ts + schedule.ts (BullMQ: команды и периодические задачи),
+                proxies/ (проверки, proxy-store), telegram/ (сессия mtcute, хранилище, классификация ошибок),
+                accounts/manager.ts (жизненный цикл клиентов), codes/ (сбор из @VerificationCodes), notify/ (бот),
+                qr/ (вход по QR), housekeeping.ts
 apps/web        SPA (routes/ — TanStack file routes, components/, lib/{api,auth,router,query-client,use-event-stream,…})
 packages/shared без IO, импортируется и вебом: env, duration, crypto (AES-256-GCM), api DTO, events,
                 settings/ (реестр настроек: types, helpers, groups, definitions, units, format, validate)
 packages/db     Drizzle schema, migrations (drizzle/), migrate-cli, testing helpers
-packages/server общие серверные сервисы для api и будущего воркера: logger, redis, bus (Redis pub/sub),
-                SettingsService, audit, process (fatal-handlers)
+packages/server общие серверные сервисы api и воркера: logger, redis, bus (Redis pub/sub), SettingsService,
+                audit, process (fatal-handlers), queues (команды воркеру), heartbeat (жив ли воркер)
 packages/ui     shadcn-компоненты (только через CLI), globals.css (тема)
 deploy/         прод: cloudflared-конфиг и юнит, deploy.sh, forced command, runbook (deploy/README.md)
 e2e/            Playwright smoke
@@ -62,9 +71,11 @@ docker compose -f compose.yml -f compose.dev.yml up -d accs-postgres accs-redis
 pnpm install
 pnpm --filter @workspace/db db:migrate
 printf '%s\n' '<пароль>' | pnpm --filter api cli admin:create --login admin --password-stdin
-pnpm dev                # api :3000 (node --watch), web :5173 (Vite, проксирует /api на :3000)
+pnpm dev                # api :3000 и worker (node --watch), web :5173 (Vite, проксирует /api на :3000)
 ```
 
+Локальный воркер подключает аккаунты из локальной БД — помните правило «один auth key — одно место».
+
 На машине владельца порты 5432/6379 заняты другими проектами: в `.env` `DEV_PG_PORT=25432`, `DEV_REDIS_PORT=26379`
 (и согласованные `DATABASE_URL`/`REDIS_URL`).
 
@@ -109,7 +120,47 @@ CLI (`apps/api/src/cli.ts`): `admin:create|admin:reset-password|admin:disable --
   экраны ошибки и «не найдено». Заголовки вкладок — `head: titleHead('Раздел')` → «Раздел | 159.team».
   Тема — `ThemeProvider` (localStorage `theme`) + скрипт в `index.html` против мигания.
 - Тесты web (jsdom): меню Base UI открывать через `defaultOpen` (повторный клик после закрытия не срабатывает);
-  `Button render={<Link/>}` имеет роль `button`. В e2e для полей с ⓘ-подсказкой — `getByLabel(..., { exact: true })`.
+  `Button render={<Link/>}` имеет роль `button`; у `<input type="file" required>` jsdom не видит файл от
+  `user.upload` — не ставить `required`, блокировать кнопку. Общие хелперы — `apps/web/src/test/{render,fixtures}`.
+  В e2e для полей с ⓘ-подсказкой — `getByLabel(..., { exact: true })`; тосты тоже `role=dialog` — диалоги
+  искать по имени (`getByRole('dialog', { name: 'Новый прокси' })`).
+- `api()` в вебе возвращает `undefined` для пустых ответов (202/204); ошибки — `ApiError` с `message` сервера.
+- Drizzle-операторы (`eq`, `and`, `sql`, …) в приложениях импортировать **из `@workspace/db`**, не из
+  `drizzle-orm`: опциональный peer `better-sqlite3` у `@mtcute/node` порождает вторую копию drizzle с
+  несовместимыми типами. В `pnpm-workspace.yaml` сборки `better-sqlite3` и `msgpackr-extract` запрещены
+  (`allowBuilds: false`).
+
+## Воркер и Telegram
+
+- Ровно один воркер: `pg_advisory_lock` при старте (`lock.ts`); при потере соединения с БД — выход. Он пишет
+  heartbeat `accs:worker:heartbeat` (версия, pid), `/api/healthz` отдаёт `worker` и `workerVersion`.
+- API → воркер: BullMQ-очередь `worker-commands` (`commands.send` — без ответа, `commands.call` — ждёт результат,
+  `WorkerTimeoutError` по таймауту). Схема команд — `packages/shared/src/commands.ts`, результаты — структурные
+  (`{ error: 'not_running' }`, а не исключения). Периодика — очередь `maintenance` (job schedulers из
+  `schedule.ts`, интервалы пересчитываются при смене настроек). Уведомления — очередь `notify` (в задачах только id).
+- Воркер → UI: события `proxies.changed`, `accounts.changed`, `code.new`, `qr.update` через bus → SSE. Веб
+  переотправляет их внутри страницы (`emitAppEvent`/`useAppEvent`) и инвалидирует запросы в `routes/_authed.tsx`.
+- Хранилище mtcute: всё, кроме ключей, — `@mtcute/postgres` (схема `mtcute`, изоляция по `account` = id
+  аккаунта, миграции один раз при старте воркера). Auth keys — своя таблица `account_auth`, зашифрованы
+  `APP_ENCRYPTION_KEY`. Импорт tdata и QR-вход кладут string session в `accounts.session_import_enc`; воркер
+  применяет её при первом подключении и обнуляет.
+- После `connect()` + `getMe()` обязательно `client.notifyLoggedIn(me.raw)` (`telegram/mtcute-session.ts`):
+  без этого не запускается цикл обновлений и живые сообщения не приходят. `client.start()` не использовать —
+  на мёртвой сессии он уходит в интерактивный вход.
+- Ошибки Telegram классифицирует `telegram/errors.ts` (unauthorized / banned / frozen / network / other) → статусы
+  аккаунта; смена статуса пишется в аудит как `system` и уходит уведомлением. Заморозка — `help.getAppConfig`
+  (`freeze_since_date`/`freeze_until_date`/`freeze_appeal_url`).
+- Коды — **только из @VerificationCodes** (`CODE_SOURCE_USERNAME`): живой обработчик + догрузка истории после
+  простоя (до 100 сообщений новее последнего сохранённого). Код — из кнопки «Copy» (`inlineButtonTypeCopy`),
+  иначе регулярка 4–8 цифр. Уведомление в канал — одна строка HTML: `<code>+77001234567</code> получен код
+  <code>575571</code>`; догруженные коды старше `notify.maxAge` в канал не уходят.
+- Прокси: дешёвая проверка — TCP-туннель до DC2 через прокси каждые N минут; раз в сутки — MTProto
+  `help.getNearestDc`, ради страны, которую видит Telegram (194.53.188.x — KZ, 194.53.189.x — JP; страна только
+  показывается). Один прокси — один аккаунт (unique). «Напрямую» — только явным выбором админа.
+- Вход по QR требует своего api_id/api_hash (`telegram.own.*`); пароль 2FA идёт в воркер через Redis pub/sub
+  (`accs:qr:<id>`), не сохраняется и не пишется в аудит.
+- Логи воркера для эксплуатации: `accounts: connected`, `codes: watching @VerificationCodes` (`caughtUp`),
+  `accounts: client error`. Телефоны и ключи в логи не пишутся.
 
 ## Инфраструктура и деплой
 
@@ -124,7 +175,7 @@ CLI (`apps/api/src/cli.ts`): `admin:create|admin:reset-password|admin:disable --
 **Deploy-job:** SSH `accs-deploy@$DEPLOY_HOST "deploy <sha>"` ключом из секрета `DEPLOY_SSH_KEY`
 (host key закреплён в `DEPLOY_KNOWN_HOSTS`, адрес — переменная `DEPLOY_HOST` окружения `production`).
 На stdin передаётся короткоживущий `GITHUB_TOKEN` для `docker login ghcr.io`. Затем job ждёт, пока
-`https://panel.159.team/api/healthz` вернёт `{"ok":true,"version":"<sha>"}`.
+`https://panel.159.team/api/healthz` вернёт `version` и `workerVersion`, равные `<sha>` (API и воркер на новом коммите).
 
 **Сервер** — staging-бокс HOSTKEY (Ubuntu 24.04, Docker 29, Compose 2.40), общий с p2c. Снаружи открыт только
 22/tcp (ключи + fail2ban), HTTP — только через Cloudflare Tunnel.
@@ -134,9 +185,10 @@ CLI (`apps/api/src/cli.ts`): `admin:create|admin:reset-password|admin:disable --
 - Ключ CI: `/home/accs-deploy/.ssh/authorized_keys` (root-owned) с `restrict,command="/usr/local/bin/accs-deploy-ssh"`.
   Forced command (`deploy/deploy-ssh`) принимает только `deploy <40-hex sha>`, проверяет, что коммит есть в
   `origin/main`, делает checkout и запускает `repo/deploy/deploy.sh` (`docker compose pull` → `up -d --wait`:
-  `accs-migrate` применяет миграции, затем `accs-api`; prune старых образов проекта).
+  `accs-migrate` применяет миграции, затем `accs-api` и `accs-worker`; prune старых образов проекта).
 - Compose на сервере: `compose.yml` + `compose.prod.yml` (образ из `ACCS_IMAGE`, `build: !reset`, ротация логов
-  json-file 10m×5). Контейнеры `accs-postgres`, `accs-redis`, `accs-migrate`, `accs-api`; тома `accs-pgdata`,
+  json-file 10m×5). Контейнеры `accs-postgres`, `accs-redis`, `accs-migrate`, `accs-api`, `accs-worker` (тот же
+  образ, `node apps/worker/src/main.ts`, без портов, `stop_grace_period: 30s`); тома `accs-pgdata`,
   `accs-redisdata`; сеть `accs-net`.
 - Занятые порты на боксе: 3000/3001/3100/5432/8080 — p2c; наш API — `127.0.0.1:3300`.
 - `APP_ENCRYPTION_KEY` хранить отдельно от дампов БД: без него зашифрованные настройки не восстановить.
@@ -154,7 +206,7 @@ CLI (`apps/api/src/cli.ts`): `admin:create|admin:reset-password|admin:disable --
   OAuth wrangler истёк — для wrangler нужен `wrangler login` владельцем.
 
 **Частые действия на сервере:** `ssh root@"$(gh variable get DEPLOY_HOST --env production)"`;
-`docker logs --tail 100 accs-api`; админ — `docker exec -i accs-api node apps/api/src/cli.ts admin:create --login <l> --password-stdin`;
+`docker logs --tail 100 accs-api` / `accs-worker`; админ — `docker exec -i accs-api node apps/api/src/cli.ts admin:create --login <l> --password-stdin`;
 здоровье туннеля — `curl -s http://127.0.0.1:20243/metrics | grep ha_connections` (норма 4).
 **Откат:** Re-run job `deploy` у прогона нужного коммита или на сервере
 `sudo -u accs-deploy bash -c 'cd /opt/accs-manager/repo && git checkout <sha> && deploy/deploy.sh <sha>'`.
@@ -162,10 +214,10 @@ CLI (`apps/api/src/cli.ts`): `admin:create|admin:reset-password|admin:disable --
 ## Статус и планы
 
 - **План 1 «Фундамент» — готов и на проде** (итоги: `docs/sessions/2026-10-03-plan-1-foundation-and-first-deploy.md`).
-- **План 2** (одним планом, решение владельца) — воркер (`apps/worker`, advisory lock, BullMQ), пул прокси (ручной ввод,
-  импорт списков, синхронизация с proxy-store `country=kz`, `category=for_all`, проверки через MTProto + `help.getNearestDc`),
-  Telegram-аккаунты на mtcute (импорт tdata, профиль, сессии, заморозка), коды из @VerificationCodes, уведомления в канал,
-  вход по QR, живая проверка на архиве из `tdata-samples/`.
+- **План 2 «Воркер, прокси, Telegram»** (`docs/superpowers/plans/2026-10-03-plan-2-worker-proxies-telegram.md`) —
+  воркер, пул прокси (ручной ввод, импорт, proxy-store `country=kz`, `category=for_all`), аккаунты из tdata и по QR,
+  профиль, сессии, заморозка, коды из @VerificationCodes, уведомления в канал. Живая проверка на архиве из
+  `tdata-samples/` через KZ-прокси пройдена в песочнице.
 - Планы пишутся перед реализацией (скилл writing-plans) от спеки `docs/superpowers/specs/2026-10-03-accs-manager-design.md`.
   Отложенные пункты из ревью плана 1 перечислены в итогах сессии (раздел «Что дальше»).
````

- [ ] **Шаг 4: Проверки**

```bash
fnm exec --using=26 pnpm typecheck
fnm exec --using=26 pnpm lint
fnm exec --using=26 npx vitest run --project api
fnm exec --using=26 npx tsc -p e2e/tsconfig.json
E2E_BASE_URL=http://localhost:5173 E2E_LOGIN=<логин> E2E_PASSWORD=<пароль> fnm exec --using=26 pnpm e2e   # против pnpm dev: 18 passed
# всё зелёное
```

- [ ] **Шаг 5: Коммит**

```bash
git add -A
git commit -F - <<'MSG'
chore: deploy waits for the worker version, e2e for proxies/accounts/QR, docs for the worker and Telegram
MSG
```

---

### Task 19: Живая проверка на архиве владельца

Ручная проверка на настоящем Telegram — то, чего не покрывают тесты. Коммита нет. Нашлось что-то — исправление с тестом в задаче-владельце, отдельным коммитом.

**Files:** нет (только запущенный стек).

- [ ] **Шаг 1: Подготовить стек**

  1. `fnm exec --using=26 pnpm dev` — api, воркер и web.
  2. Войти в панель.
  3. В «Настройках» заполнить:
     - «Уведомления»: токен бота, ID канала (`-100…`), включить уведомления;
     - «proxy-store»: API-ключ, включить синхронизацию.

     Ключи владелец вводит сам, в чат и в git они не попадают.
  4. Дождаться синхронизации на странице «Прокси»: у прокси `194.53.188.x` страна **KZ**, у `194.53.189.x` — **JP**.

- [ ] **Шаг 2: Импорт архива через KZ-прокси**

  1. «Аккаунты» → «Добавить аккаунт» → «Из tdata».
  2. Загрузить архив из `tdata-samples/`. Ожидание: найден 1 аккаунт, DC2.
  3. Выбрать прокси `194.53.188.x` и нажать «Добавить 1».

  Ожидание:
  - в течение нескольких секунд статус «активен», в карточке телефон и имя;
  - в логе воркера `accounts: connected` и `codes: watching @VerificationCodes` (`caughtUp` = число догруженных сообщений).

- [ ] **Шаг 3: Сессии и заморозка**

  В карточке нажать «Показать активные сессии». Ожидание:
  - текущая сессия «Telegram Desktop 7.2.9 x64», устройство «Desktop, Windows 11 x64», официальное приложение;
  - в аудите есть `account.sessions.read`;
  - статус не «заморожен» (или заморожен — тогда коды всё равно принимаются).

- [ ] **Шаг 4: Живой код**

  1. Запросить код в любом сервисе, который отправляет его через Telegram Gateway на номер аккаунта.
  2. Ожидание:
     - код за секунды появляется в ленте «Коды» с меткой «новый»;
     - в канале — строка `+7… получен код NNNNNN`.
  3. Если код не пришёл, проверить, что цикл обновлений mtcute запущен. Временно поставить `logLevel: 5` в `mtcute-session.ts`: в логе должно быть `updates loop started`. Затем вернуть `logLevel: 1`.

- [ ] **Шаг 5: Отпустить ключ**

  1. «Пауза» или «Удалить» **без** «Завершить сессию в Telegram» — перед тем как этот же архив будет подключён в другом месте (прод).
  2. В логе воркера клиент остановлен, статус «на паузе».

## После плана 2

1. **Финальное ревью ветки и слияние.** По решению владельца — пуш в `main`, это деплой в прод. CI ждёт, пока `version` и `workerVersion` в `/api/healthz` станут новым коммитом.
2. **Настройки прода** (вводит владелец):
   - «Уведомления»: токен бота, ID канала `-1003508630500`;
   - «proxy-store»: ключ и включение;
   - для входа по QR — свой api_id/api_hash с my.telegram.org.
3. **Перенос аккаунтов на прод** — только после паузы или удаления (без выхода) в песочнице и локально.
4. **Отложенное из ревью плана 1, не вошедшее сюда:**
   - глубина redaction в pino;
   - `params` в ошибках drizzle в логах;
   - периодическая перезагрузка настроек как страховка;
   - SSE шлёт события всем админам (админы равны, коды видят все);
   - a11y-проход.

## Поправки после выполнения (2026-10-03)

План выполнен как написан. Отличия от кода задач внесены отдельными коммитами после финального ревью и первого прогона CI.

- **Тесты задач 6 и 10:** хосты прокси генерируются счётчиком вместо случайного октета (случайный в части прогонов совпадал).
- **Задача 4:** у `accs-worker` есть настоящий healthcheck. Heartbeat трогает `/tmp/accs-worker-alive`, проверка требует, чтобы файл был моложе минуты. С `healthcheck: disable` команда `docker compose up --wait` в CI и в `deploy.sh` падала: «has no healthcheck configured».
- **Финальное ревью:**
  - предпросмотр списка прокси не пишется в аудит;
  - менеджер аккаунтов:
    - игнорирует ошибки остановленных и заменённых клиентов, пауза во время подключения остаётся паузой;
    - таймаут подключения 90 с;
    - неудачный logout сохраняет клиента;
    - `onProxyUp` не ждёт Telegram;
  - сборщик кодов повторяет поиск @VerificationCodes и догрузку истории, историю старше срока хранения не возвращает;
  - лента кодов отсортирована по времени сообщения, «новый» ставится только свежим кодам;
  - импорт принимает прокси по общему правилу (`ok`/`unchecked`/`failing`);
  - QR: «неверный пароль» держится на экране, клиент входа уничтожается до старта аккаунта;
  - пустой ответ proxy-store не гасит весь пул.
