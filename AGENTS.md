# accs-manager — заметки для агентов

Веб-панель владельца для его Telegram-аккаунтов: импорт сессий из portable Telegram Desktop `tdata` (zip),
сбор кодов подтверждения из чата @VerificationCodes (Telegram Gateway) всех аккаунтов в одном месте
(чат 777000 не отслеживается), дублирование новых кодов в приватный
Telegram-канал через бота, пул прокси (прокси на аккаунт), несколько равноправных админов с глобальным аудитом,
типизированные настройки в БД.

**Прод:** https://panel.159.team — деплоится автоматически из `main`. Язык общения с владельцем и текстов UI — русский.

## Жёсткие правила

- **Репозиторий публичный.** Никаких секретов в git, логах, фикстурах и документации: токены, пароли, ключи,
  содержимое `.env`, API-ключ proxy-store (живёт только в зашифрованной настройке `proxyStore.apiKey`),
  IP прод-сервера (берите из `gh variable get DEPLOY_HOST --env production`).
- **`.secrets/`** (в `.gitignore` и `.dockerignore`) — локальные копии прод-секретов; там
  `prod-app-encryption-key` (резервная копия `APP_ENCRYPTION_KEY` прода). Не печатать, не коммитить.
- **`tdata-samples/`** содержит живой auth key владельца: не открывать в логах, не печатать байты ключей,
  не коммитить (в `.gitignore`).
- **Один auth key — одно место.** Сессию аккаунта нельзя одновременно держать подключённой в двух местах
  (прод, песочница, локальный dev, исходный Telegram Desktop): Telegram отзовёт её (`AUTH_KEY_DUPLICATED`).
  Перед импортом той же tdata в другое место — пауза или удаление аккаунта там. Удаление «без выхода» только
  перестаёт пользоваться ключом; «с выходом» (`?logout=true`) завершает сессию в Telegram и для владельца.
- **Пуш в `main` = деплой в прод.** Перед пушем: `pnpm lint`, `pnpm typecheck`, `pnpm test`, для изменений UI —
  e2e (`E2E_BASE_URL=http://localhost:5173 pnpm e2e` против dev). Проверить дифф на секреты. После пуша — следить
  за прогоном (`gh run watch`). Крупную работу — через ветку. Коммиты, меняющие только `docs/**` и `*.md`,
  CI не запускают и не передеплоивают (`paths-ignore`).
- Сервер общий с проектами p2c (sbpredator): их контейнеры `p2c-*`, туннели `cloudflared`, `cloudflared-p2c-pgon`,
  `~/.cloudflared/cert.pem` (sbpredator) **не трогать**.
- Секреты никогда не возвращаются API и в аудите заменяются на `[redacted]`.
- Весь UI — только компоненты shadcn/ui (Base UI) из `packages/ui`, добавлять через CLI
  (`npx shadcn@latest add <...> -c apps/web -y`), правила — скилл `.claude/skills/shadcn`.

## Стек

Node 26 (TypeScript исполняется напрямую — type stripping, без сборки api), pnpm 12.8.2 + Turborepo, TypeScript 6,
Hono 4 (+ @hono/node-server), Drizzle ORM 0.45 + drizzle-kit, PostgreSQL 18, Redis 8 (ioredis), pino 10, Zod 4,
React 19 + Vite 8, TanStack Router (file-based, autoCodeSplitting) / Query 5 / Table, shadcn (Base UI, Tailwind 4,
`cn` из пакета `cn`), Vitest 5 + testcontainers, Playwright. Воркер: BullMQ 6 (очереди в Redis). Telegram:
mtcute 0.32.3 — `@mtcute/node` (клиент, http/socks-транспорты), `@mtcute/convert` (tdata → string session),
`@mtcute/postgres` (хранилище в схеме `mtcute`), QR-код в браузере — `qrcode`.

## Структура

```
apps/api        Hono API + CLI (src/main.ts, src/app.ts, src/cli.ts; routes/, middleware/{origin,auth,audit}, lib/, services/)
apps/worker     воркер: lock.ts (advisory lock), runtime.ts + schedule.ts (BullMQ: команды и периодические задачи),
                proxies/ (проверки, proxy-store), telegram/ (сессия mtcute, хранилище, классификация ошибок),
                accounts/manager.ts (жизненный цикл клиентов), codes/ (сбор из @VerificationCodes), notify/ (бот),
                qr/ (вход по QR), housekeeping.ts
apps/web        SPA (routes/ — TanStack file routes, components/, lib/{api,auth,router,query-client,use-event-stream,…})
packages/shared без IO, импортируется и вебом: env, duration, crypto (AES-256-GCM), api DTO, events,
                settings/ (реестр настроек: types, helpers, groups, definitions, units, format, validate)
packages/db     Drizzle schema, migrations (drizzle/), migrate-cli, testing helpers
packages/server общие серверные сервисы api и воркера: logger, redis, bus (Redis pub/sub), SettingsService,
                audit, process (fatal-handlers), queues (команды воркеру), heartbeat (жив ли воркер)
packages/ui     shadcn-компоненты (только через CLI), globals.css (тема)
deploy/         прод: cloudflared-конфиг и юнит, deploy.sh, forced command, runbook (deploy/README.md)
e2e/            Playwright smoke
docs/           superpowers/specs (спека), superpowers/plans (планы), sessions (итоги сессий)
```

## Разработка

```bash
# Node 26 обязателен (engines >=26); на этой машине по умолчанию fnm-Node 22/24 — запускать через:
fnm exec --using=26 <команда>

cp .env.example .env    # APP_ENCRYPTION_KEY, POSTGRES_PASSWORD (+ в DATABASE_URL); PUBLIC_ORIGIN=http://localhost:5173
docker compose -f compose.yml -f compose.dev.yml up -d accs-postgres accs-redis   # порты из DEV_PG_PORT/DEV_REDIS_PORT
pnpm install
pnpm --filter @workspace/db db:migrate
printf '%s\n' '<пароль>' | pnpm --filter api cli admin:create --login admin --password-stdin
pnpm dev                # api :3000 и worker (node --watch), web :5173 (Vite, проксирует /api на :3000)
```

Локальный воркер подключает аккаунты из локальной БД — помните правило «один auth key — одно место».

На машине владельца порты 5432/6379 заняты другими проектами: в `.env` `DEV_PG_PORT=25432`, `DEV_REDIS_PORT=26379`
(и согласованные `DATABASE_URL`/`REDIS_URL`).

Проверки: `pnpm lint`, `pnpm typecheck`, `pnpm test` (vitest, проекты shared/db/server/api/web; интеграционные
тесты сами поднимают Postgres 18 и Redis 8 через testcontainers один раз на прогон; в CI вместо этого
`TEST_PG_URL`/`TEST_REDIS_URL`), `npx tsc -p e2e/tsconfig.json`, e2e — `E2E_BASE_URL=... pnpm e2e`
(логин/пароль `E2E_LOGIN`/`E2E_PASSWORD`, по умолчанию `e2e`/`e2e-password-123`).

CLI (`apps/api/src/cli.ts`): `admin:create|admin:reset-password|admin:disable --login <l>`,
`settings:get [key]`, `settings:set <key> <value>` (значение приводится по типу настройки, может начинаться с `-`),
`settings:reset <key>`. Пароли и секретные настройки — только через stdin (`--password-stdin`, `--value-stdin`).

## Конвенции

- Серверный TS исполняется Node напрямую: `erasableSyntaxOnly` (без `enum`, `namespace`, parameter properties),
  относительные импорты с расширением `.ts`, `import type` для типов. Workspace-пакеты экспортируют исходники.
- Зависимости — мажорными диапазонами (`pnpm add 'pkg@^N'`): pnpm 12 не ставит версии моложе `minimumReleaseAge`.
  Если pnpm дописал `minimumReleaseAgeExclude` — убрать и `pnpm up <pkg>`. Нативных зависимостей нет
  (argon2id — `node:crypto`). Corepack в Node 26 нет.
- `.env` — **только инфраструктура**: `NODE_ENV`, `PORT`, `DATABASE_URL`, `REDIS_URL`, `APP_ENCRYPTION_KEY`,
  `PUBLIC_ORIGIN`, `TRUST_PROXY`, `LOG_LEVEL` (+ для compose `POSTGRES_PASSWORD`, `API_BIND`, `API_PORT`,
  `DEV_PG_PORT`, `DEV_REDIS_PORT`). `APP_VERSION` зашивается в образ (`GIT_SHA`). Всё остальное — настройки в БД.
- **Новая настройка** = запись в `packages/shared/src/settings/definitions.ts` через хелперы
  (`int/decimal/string/text/bool/select/multiselect/duration/secret`) с `group`, `label`, обязательными
  `description` (строка под названием) и `help` (ⓘ-popover, абзацы через пустую строку), `unit` для чисел
  (`units.*` — склоняемые формы), `effect` (`immediate`/`new_connections`/`restart`). UI раздела «Настройки»
  строится из определений автоматически; сервер и SPA валидируют одними zod-схемами. Тест
  `packages/shared/test/settings-format.test.ts` требует description/help/unit. Разумные значения задаются как
  `default` в коде (не данными в БД): переопределение админом — строка в `settings`, сброс возвращает к умолчанию.
- `telegram.desktop.*` по умолчанию = то, что шлёт официальный Telegram Desktop portable x64 (`TDESKTOP` в
  `definitions.ts`: api_id 2040 + публичный api_hash, `Desktop`, `Windows 11 x64`, `7.2.9 x64`; источники —
  tdesktop `mtproto/session_private.cpp` `ComputeAppVersion`, desktop-app/lib_base `base_info_win.cpp`).
  При выходе новой стабильной версии Telegram Desktop поднимать `TDESKTOP.appVersion`. Параметры устройства
  записываются в аккаунт при добавлении — смена касается только новых аккаунтов.
- Секреты в БД: AES-256-GCM `v1:<iv>:<ct>:<tag>` ключом `APP_ENCRYPTION_KEY`. Живое применение настроек —
  Redis pub/sub `settings.changed` → `SettingsService` перечитывает кеш.
- API: валидация `zValidator(..., validationHook)`, мутирующие запросы проходят Origin guard и глобальный
  audit-middleware (`audited('action')` задаёт имя действия). Сессии — cookie `accs_session`
  (HttpOnly, SameSite=Strict, Secure при https `PUBLIC_ORIGIN`), в БД sha256 токена. Лимит тела `/api` — 1 МиБ.
  SSE `/api/events` перепроверяет сессию на каждом heartbeat (25 с).
- Web: роутер создаётся `createAppRouter` (`apps/web/src/lib/router.ts`) — и в `main.tsx`, и в тестах; там же
  экраны ошибки и «не найдено». Заголовки вкладок — `head: titleHead('Раздел')` → «Раздел | 159.team».
  Тема — `ThemeProvider` (localStorage `theme`) + скрипт в `index.html` против мигания.
- Тесты web (jsdom): меню Base UI открывать через `defaultOpen` (повторный клик после закрытия не срабатывает);
  `Button render={<Link/>}` имеет роль `button`; у `<input type="file" required>` jsdom не видит файл от
  `user.upload` — не ставить `required`, блокировать кнопку. Общие хелперы — `apps/web/src/test/{render,fixtures}`.
  В e2e для полей с ⓘ-подсказкой — `getByLabel(..., { exact: true })`; тосты тоже `role=dialog` — диалоги
  искать по имени (`getByRole('dialog', { name: 'Новый прокси' })`).
- `api()` в вебе возвращает `undefined` для пустых ответов (202/204); ошибки — `ApiError` с `message` сервера.
- Drizzle-операторы (`eq`, `and`, `sql`, …) в приложениях импортировать **из `@workspace/db`**, не из
  `drizzle-orm`: опциональный peer `better-sqlite3` у `@mtcute/node` порождает вторую копию drizzle с
  несовместимыми типами. В `pnpm-workspace.yaml` сборки `better-sqlite3` и `msgpackr-extract` запрещены
  (`allowBuilds: false`).

## Воркер и Telegram

- Ровно один воркер: `pg_advisory_lock` при старте (`lock.ts`); при потере соединения с БД — выход. Он пишет
  heartbeat `accs:worker:heartbeat` (версия, pid), `/api/healthz` отдаёт `worker` и `workerVersion`.
- API → воркер: BullMQ-очередь `worker-commands` (`commands.send` — без ответа, `commands.call` — ждёт результат,
  `WorkerTimeoutError` по таймауту). Схема команд — `packages/shared/src/commands.ts`, результаты — структурные
  (`{ error: 'not_running' }`, а не исключения). Периодика — очередь `maintenance` (job schedulers из
  `schedule.ts`, интервалы пересчитываются при смене настроек). Уведомления — очередь `notify` (в задачах только id).
- Воркер → UI: события `proxies.changed`, `accounts.changed`, `code.new`, `qr.update` через bus → SSE. Веб
  переотправляет их внутри страницы (`emitAppEvent`/`useAppEvent`) и инвалидирует запросы в `routes/_authed.tsx`.
- Хранилище mtcute: всё, кроме ключей, — `@mtcute/postgres` (схема `mtcute`, изоляция по `account` = id
  аккаунта, миграции один раз при старте воркера). Auth keys — своя таблица `account_auth`, зашифрованы
  `APP_ENCRYPTION_KEY`. Импорт tdata и QR-вход кладут string session в `accounts.session_import_enc`; воркер
  применяет её при первом подключении и обнуляет.
- После `connect()` + `getMe()` обязательно `client.notifyLoggedIn(me.raw)` (`telegram/mtcute-session.ts`):
  без этого не запускается цикл обновлений и живые сообщения не приходят. `client.start()` не использовать —
  на мёртвой сессии он уходит в интерактивный вход.
- Ошибки Telegram классифицирует `telegram/errors.ts` (unauthorized / banned / frozen / network / other) → статусы
  аккаунта; смена статуса пишется в аудит как `system` и уходит уведомлением. Заморозка — `help.getAppConfig`
  (`freeze_since_date`/`freeze_until_date`/`freeze_appeal_url`).
- Коды — **только из @VerificationCodes** (`CODE_SOURCE_USERNAME`): живой обработчик + догрузка истории после
  простоя (до 100 сообщений новее последнего сохранённого). Код — из кнопки «Copy» (`inlineButtonTypeCopy`),
  иначе регулярка 4–8 цифр. Уведомление в канал — одна строка HTML: `<code>+77001234567</code> получен код
  <code>575571</code>`; догруженные коды старше `notify.maxAge` в канал не уходят.
- Прокси: дешёвая проверка — TCP-туннель до DC2 через прокси каждые N минут; раз в сутки — MTProto
  `help.getNearestDc`, ради страны, которую видит Telegram (194.53.188.x — KZ, 194.53.189.x — JP; страна только
  показывается). Один прокси — один аккаунт (unique). «Напрямую» — только явным выбором админа.
- Вход по QR требует своего api_id/api_hash (`telegram.own.*`); пароль 2FA идёт в воркер через Redis pub/sub
  (`accs:qr:<id>`), не сохраняется и не пишется в аудит.
- Логи воркера для эксплуатации: `accounts: connected`, `codes: watching @VerificationCodes` (`caughtUp`),
  `accounts: client error`. Телефоны и ключи в логи не пишутся.

## Инфраструктура и деплой

Подробный runbook — `deploy/README.md`.

**Пайплайн** (`.github/workflows/ci.yml`, на пуш в `main` и PR):
`checks` (lint, typecheck, tsc e2e, vitest с сервисами postgres/redis) → `e2e` (compose-стек + Playwright) →
`publish` (только `main`: образ target `api`, `linux/amd64`, `GIT_SHA`, в GHCR
`ghcr.io/nokimaro/accs-manager:<sha>` и `:main`, кеш gha) → `deploy` (environment `production`, доступен только
ветке `main`; concurrency `deploy-production` без отмены). Для `main` прогоны не отменяют друг друга.

**Deploy-job:** SSH `accs-deploy@$DEPLOY_HOST "deploy <sha>"` ключом из секрета `DEPLOY_SSH_KEY`
(host key закреплён в `DEPLOY_KNOWN_HOSTS`, адрес — переменная `DEPLOY_HOST` окружения `production`).
На stdin передаётся короткоживущий `GITHUB_TOKEN` для `docker login ghcr.io`. Затем job ждёт, пока
`https://panel.159.team/api/healthz` вернёт `version` и `workerVersion`, равные `<sha>` (API и воркер на новом коммите).

**Сервер** — staging-бокс HOSTKEY (Ubuntu 24.04, Docker 29, Compose 2.40), общий с p2c. Снаружи открыт только
22/tcp (ключи + fail2ban), HTTP — только через Cloudflare Tunnel.
- `/opt/accs-manager` (владелец `accs-deploy`, группа `docker`): `.env` (600; сгенерированы на сервере
  `POSTGRES_PASSWORD`, `APP_ENCRYPTION_KEY`; `PUBLIC_ORIGIN=https://panel.159.team`, `TRUST_PROXY=true`,
  `API_BIND=127.0.0.1`, `API_PORT=3300`), `repo/` — клон, переключается на деплоимый коммит, `deployed-sha`, `deploy.lock`.
- Ключ CI: `/home/accs-deploy/.ssh/authorized_keys` (root-owned) с `restrict,command="/usr/local/bin/accs-deploy-ssh"`.
  Forced command (`deploy/deploy-ssh`) принимает только `deploy <40-hex sha>`, проверяет, что коммит есть в
  `origin/main`, делает checkout и запускает `repo/deploy/deploy.sh` (`docker compose pull` → `up -d --wait`:
  `accs-migrate` применяет миграции, затем `accs-api` и `accs-worker`; prune старых образов проекта).
- Compose на сервере: `compose.yml` + `compose.prod.yml` (образ из `ACCS_IMAGE`, `build: !reset`, ротация логов
  json-file 10m×5). Контейнеры `accs-postgres`, `accs-redis`, `accs-migrate`, `accs-api`, `accs-worker` (тот же
  образ, `node apps/worker/src/main.ts`, без портов, `stop_grace_period: 30s`); тома `accs-pgdata`,
  `accs-redisdata`; сеть `accs-net`.
- Занятые порты на боксе: 3000/3001/3100/5432/8080 — p2c; наш API — `127.0.0.1:3300`.
- `APP_ENCRYPTION_KEY` хранить отдельно от дампов БД: без него зашифрованные настройки не восстановить.

**Cloudflare** (аккаунт nox@nox.kz, зона `159.team`):
- Именованный туннель `accs-manager` (id `2c394400-9bae-48b4-85ab-1c222eda90a3`), конфиг — `deploy/cloudflared-accs.yml`
  → `/etc/cloudflared/accs-manager.yml`, удостоверение `/etc/cloudflared/accs-manager.json`, юнит
  `cloudflared-accs.service` (`Restart=always`), метрики `127.0.0.1:20243` (20241 — p2c staging, 20242 — p2c-pgon),
  drop-in `cloudflared-update.service.d/restart-accs.conf` перезапускает наш юнит после автообновления cloudflared.
- Ingress: `panel.159.team` → `http://127.0.0.1:3300`, остальное — 404. Маршруты правятся **только в git**, затем
  копируются на сервер, `cloudflared tunnel --config … ingress validate`, `systemctl restart cloudflared-accs`.
- DNS: `panel.159.team` — CNAME на туннель (proxied); apex `159.team` намеренно без записей.
- Управление туннелем/DNS с машины владельца: `cloudflared --origincert ~/.cloudflared/cert-159team.pem tunnel …`
  (сертификат зоны 159.team). `~/.cloudflared/cert.pem` — сертификат sbpredator.com для p2c, не перезаписывать.
  OAuth wrangler истёк — для wrangler нужен `wrangler login` владельцем.

**Частые действия на сервере:** `ssh root@"$(gh variable get DEPLOY_HOST --env production)"`;
`docker logs --tail 100 accs-api` / `accs-worker`; админ — `docker exec -i accs-api node apps/api/src/cli.ts admin:create --login <l> --password-stdin`;
здоровье туннеля — `curl -s http://127.0.0.1:20243/metrics | grep ha_connections` (норма 4).
**Откат:** Re-run job `deploy` у прогона нужного коммита или на сервере
`sudo -u accs-deploy bash -c 'cd /opt/accs-manager/repo && git checkout <sha> && deploy/deploy.sh <sha>'`.

## Статус и планы

- **План 1 «Фундамент» — готов и на проде** (итоги: `docs/sessions/2026-10-03-plan-1-foundation-and-first-deploy.md`).
- **План 2 «Воркер, прокси, Telegram»** (`docs/superpowers/plans/2026-10-03-plan-2-worker-proxies-telegram.md`) —
  воркер, пул прокси (ручной ввод, импорт, proxy-store `country=kz`, `category=for_all`), аккаунты из tdata и по QR,
  профиль, сессии, заморозка, коды из @VerificationCodes, уведомления в канал. Живая проверка на архиве из
  `tdata-samples/` через KZ-прокси пройдена в песочнице.
- Планы пишутся перед реализацией (скилл writing-plans) от спеки `docs/superpowers/specs/2026-10-03-accs-manager-design.md`.
  Отложенные пункты из ревью плана 1 перечислены в итогах сессии (раздел «Что дальше»).

<!-- BEGIN:turborepo-agent-rules -->

# This is NOT the Turborepo you know

Turborepo configuration, task behavior, and CLI commands can vary between installed versions and may differ from your training data. Resolve the `turbo` package from this file's directory or relevant workspace; in monorepos, it may not be visible from the repository root. For example, run `node -p "require.resolve('turbo/package.json')"` from a workspace that depends on `turbo`.

Read `docs/README.md` inside that installed package first, then read the relevant pages from its `docs/` directory before changing Turborepo configuration or commands. Heed deprecation notices. These bundled docs match the installed package version and are available without network access.

This block is written and re-added by `turbo` before repository-scoped commands when an AI agent is detected. In the Turborepo source repository, its template is defined in `crates/turborepo-cli/src/cli/agent_guidance.rs`. Removing the managed block while updates are enabled means a later qualifying invocation will add it again. Set `"agentGuidance": false` in the root `turbo.json` or `turbo.jsonc` to opt out; this does not remove an existing block. Keep the block committed with your work to avoid an uncommitted change on the next agent invocation.
<!-- END:turborepo-agent-rules -->
