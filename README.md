# accs-manager

Панель управления Telegram-аккаунтами: импорт tdata / вход по QR, пул прокси, коды из `777000` в одном месте.
Дизайн — `docs/superpowers/specs/2026-10-03-accs-manager-design.md`.

## Разработка

```bash
cp .env.example .env                 # заполнить APP_ENCRYPTION_KEY (команда в комментарии)
docker compose -f compose.yml -f compose.dev.yml up -d accs-postgres accs-redis
pnpm install
pnpm --filter @workspace/db db:migrate
pnpm --filter api cli admin:create --login admin
pnpm dev                             # api :3000 (watch), web :5173 (Vite, проксирует /api)
```

Проверки: `pnpm lint`, `pnpm typecheck`, `pnpm test` (интеграционные тесты сами поднимают Postgres и Redis через testcontainers),
`E2E_BASE_URL=... pnpm e2e`.

## Запуск на сервере

```bash
cp .env.example .env                 # POSTGRES_PASSWORD, APP_ENCRYPTION_KEY, PUBLIC_ORIGIN (https://...), TRUST_PROXY=true за reverse proxy
docker compose up -d --build
docker compose exec accs-api node apps/api/src/cli.ts admin:create --login admin
```

Остальные параметры (Telegram, уведомления, прокси, лимиты) — в панели, раздел «Настройки», или `cli settings:set`.
