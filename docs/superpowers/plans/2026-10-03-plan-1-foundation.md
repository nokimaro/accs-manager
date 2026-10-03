# План 1 — Фундамент: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Поднять монорепо accs-manager с работающим фундаментом: вход админов, управление админами, аудит, типизированные настройки в БД с разделом в админке, layout с navbar, Docker compose и CI.

**Architecture:** pnpm 12 + Turborepo. `apps/api` — Hono на Node 26, TypeScript исполняется напрямую (type stripping), без сборки. `apps/web` — React + Vite SPA на shadcn (Base UI). `packages/shared` — чистые схемы, типы и настройки без IO (импортируется и вебом). `packages/db` — Drizzle и миграции. `packages/server` — серверные сервисы для api и будущего worker: логгер, Redis, шина событий, SettingsService, аудит. Воркер, прокси и Telegram — планы 2 и 3.

**Tech Stack:** Node 26.10, TypeScript 6.0, pnpm 12.8.2, Turborepo 2.11, Hono 4.13 + @hono/node-server 2.1, Drizzle ORM 0.45 + drizzle-kit 0.31 + pg 8.23, ioredis 6, pino 10, Zod 4.6, Vitest 5 + testcontainers 12, React 19.2, Vite 8, TanStack Router 1.170 / Query 5.104 / Table 9, shadcn 4.21 (Base UI 1.8, Tailwind 4), Playwright 1.63.

**Spec:** `docs/superpowers/specs/2026-10-03-accs-manager-design.md` — исполнитель читает спеку и план вместе.

**Как получен код:** весь код плана написан и прогнан в песочнице до записи в план; каждая задача проверена отдельно (состояние «после задач 1…N» → typecheck, lint, тесты). Итог: 80 тестов vitest (unit, интеграционные на Postgres 18/Redis 8, компонентные) и 12 e2e (desktop + Pixel 7) против собранного Docker-образа.

## Global Constraints

- Node `26` (образ `node:26-trixie-slim`), PostgreSQL `18` (`postgres:18-trixie`), Redis `8` (`redis:8-trixie`), pnpm `12.8.2` (`packageManager: "pnpm@12.8.2"`; в Docker — `npm i -g pnpm@12.8.2`: corepack в Node 26 отсутствует). Локально: `export COREPACK_ENABLE_DOWNLOAD_PROMPT=0`.
- Зависимости — только мажорными диапазонами (`'pkg@^N'`): pnpm 12 по умолчанию не ставит версии моложе `minimumReleaseAge`. Если pnpm дописал `minimumReleaseAgeExclude` — удалить и выполнить `pnpm up <pkg>`.
- `.env` содержит **только**: `NODE_ENV`, `PORT`, `DATABASE_URL`, `REDIS_URL`, `APP_ENCRYPTION_KEY`, `PUBLIC_ORIGIN`, `TRUST_PROXY`, `LOG_LEVEL` (+ переменные compose: `POSTGRES_PASSWORD`, `API_BIND`, `API_PORT`, `DEV_PG_PORT`, `DEV_REDIS_PORT`). Всё остальное — настройки в БД (спека §9).
- Серверный TS исполняется Node напрямую: `erasableSyntaxOnly` (без `enum`, `namespace`, parameter properties), относительные импорты — с `.ts`, `import type` для типов. Workspace-пакеты экспортируют исходники (`"exports": {"./x": "./src/x.ts"}`).
- Без нативных зависимостей (argon2id — `node:crypto`).
- Шифротекст: `v1:<iv>:<ciphertext>:<tag>` (base64), AES-256-GCM, ключ `APP_ENCRYPTION_KEY` (32 байта, base64).
- Секреты (`password`, `passcode`, значения `secret`-настроек, токены, ключи) никогда не возвращаются API и в аудите заменяются на `[redacted]`.
- Весь UI — только компоненты shadcn/ui (Base UI) из `packages/ui`, добавляемые CLI (`npx shadcn@latest add <...> -c apps/web -y`), по правилам скилла `.claude/skills/shadcn`: `FieldGroup`/`Field`, `gap-*`, семантические токены, `Badge`/`Empty`/`Skeleton`/`Alert`/`toast`, иконки в кнопках — `data-icon`. Тексты UI — на русском.
- Docker-ресурсы — с префиксом `accs-` (сервисы, контейнеры, тома, сеть).
- После каждой задачи — локальный `git commit`. **Никогда не `git push`** (пуш — после плана 3).
- Реальные tdata/ключи/токены в репозиторий, логи и фикстуры не попадают.

## Уточнения к спеке, принятые в плане

1. **Навигация:** вместо `NavigationMenu` — `Tabs` + `TabsList variant="line"` с триггерами-ссылками (`TabsTrigger nativeButton={false} render={<Link/>}`) в `<nav>`: стиль line-табов встроенным вариантом, без своих стилей. В мобильном `Sheet` — те же табы `orientation="vertical"`.
2. **`packages/server`** — серверные сервисы для api и worker (в спеке — часть `shared`); `shared` остаётся без IO и безопасен для фронтенда.
3. **Настройки без проекции в JSON Schema:** SPA импортирует определения напрямую из `@workspace/shared/settings` и валидирует теми же zod-схемами; API отдаёт только значения. `z.registry`/`z.toJSONSchema` не нужны (метаданные — в типизированных объектах определений).
4. **Rate limit входа считает только неудачные попытки** (по IP и по логину); успешные входы никого не блокируют (найдено на превью: после ~10 нормальных входов был 429).
5. **compose:** имена `accs-*`; `compose.dev.yml` публикует Postgres/Redis на настраиваемых портах (`DEV_PG_PORT`/`DEV_REDIS_PORT`).
6. **Цветовая тема:** `blue` + базовый `mist` (shadcn preset `nova`, Base UI).

## Review Focus

Входы и режимы отказа, которые спека подразумевает, но прямо не проговаривает. Каждый закреплён тестом в задаче-владельце.

1. **Вход по `http://localhost` в dev.** Cookie с `Secure` Safari не сохраняет на `http://localhost` → вход «молча» не работает. Ожидание: `Secure` — только если `PUBLIC_ORIGIN` начинается с `https://`. Тест — задача 9 («omits Secure for an http PUBLIC_ORIGIN»).
2. **Отключённый админ с живой сессией.** Ожидание: после `disable` все его сессии отозваны, следующий запрос — 401; последнего активного админа отключить нельзя (409). Тест — задача 11.
3. **Обработчик бросил исключение / тело multipart или огромное.** Ожидание: запись аудита всё равно создаётся с `result=error`; файлы — `[redacted:file]`; тело > 16 КБ — `{ truncated, preview }`. Тест — задача 10.
4. **Пустая строка в `secret`-настройке.** Ожидание: `""` — ошибка «используйте Очистить», `null` — очистить; значение секрета не возвращается ни в `GET`, ни в ответе `PATCH`, ни в аудите. Тест — задача 12.
5. **IP клиента за reverse proxy.** Ожидание: при `TRUST_PROXY=false` берётся адрес сокета (подделанный `X-Forwarded-For` игнорируется), при `true` — первый адрес из `X-Forwarded-For`; от этого зависят rate limit и аудит. Тест — задача 10.

## Перед началом

- Превью из песочницы (контейнеры `accs-postgres`, `accs-redis`, тома `accs-pgdata`, `accs-redisdata`, сеть `accs-net`, процессы на `:3000` и `:5173`) займёт те же имена и порты — **остановить и удалить его до задачи 14**.
- Порты 5432/6379 на этой машине заняты другими проектами: в `.env` выставить `DEV_PG_PORT`/`DEV_REDIS_PORT` (например 25432/26379) и согласовать `DATABASE_URL`/`REDIS_URL`.

---

## Файловая структура

```
.
├── package.json · pnpm-workspace.yaml · turbo.json · tsconfig.json · tsconfig.node.json · eslint.config.js
├── vitest.config.ts · vitest.global-setup.ts   # проекты shared/db/server/api/web; testcontainers один раз на прогон
├── playwright.config.ts · e2e/                 # smoke против запущенного стека
├── Dockerfile · .dockerignore · compose.yml · compose.dev.yml · .env.example · README.md
├── .github/workflows/ci.yml
├── packages/
│   ├── shared/src/{env,duration,crypto,api,events}.ts, settings/{types,helpers,groups,definitions,validate,index}.ts
│   ├── db/src/{schema,client,migrate,migrate-cli,testing,index}.ts, drizzle/ (миграции)
│   ├── server/src/{logger,redis,bus,settings-service,audit,index}.ts
│   └── ui/                                       # shadcn (только CLI)
└── apps/
    ├── api/src/{main,app,deps,cli}.ts, lib/{password,sessions,rate-limit,client-ip}.ts,
    │         middleware/{origin,auth,audit}.ts, services/admins.ts, routes/{health,validation,auth,admins,settings,audit,events}.ts
    └── web/src/{main.tsx,routeTree.gen.ts}, lib/{api,query-client,auth,settings,admins,audit,format,use-event-stream}.ts,
              components/{nav-tabs,mobile-nav,app-header,user-menu,connection-indicator,password-input,change-password-dialog,
                          page-header,setup-alert,data-table}.tsx, components/settings/*, components/admins/*,
              routes/{__root,login,_authed}.tsx, routes/_authed/{index,accounts,proxies,audit,admins,settings}.tsx
```

## Задачи

| # | Задача | Результат |
|---|---|---|
| 1 | Каркас монорепо | shadcn vite monorepo, pnpm 12, Node 26, тема |
| 2 | `shared`: env, длительности, шифрование | 13 тестов |
| 3 | Ядро настроек | реестр v1 + type-тесты, 25 тестов `shared` |
| 4 | `db`: схема, миграции, тестовая БД | testcontainers, 4 теста |
| 5 | `server`: логгер, Redis, шина | 1 тест |
| 6 | SettingsService | 8 тестов `server` |
| 7 | Аудит | 11 тестов `server` |
| 8 | API: каркас | 2 теста `api` |
| 9 | Вход админов | 10 |
| 10 | Глобальный аудит | 17 |
| 11 | Админы | 22 |
| 12 | Настройки и SSE | 29 |
| 13 | CLI | 32 |
| 14 | Docker, compose, README | стек `accs-*` поднимается |
| 15 | Web: вход, layout, навигация | 4 теста `web` |
| 16 | Web: «Настройки» | 8 |
| 17 | Web: «Админы», «Аудит» | сборка + ручная проверка |
| 18 | E2E и CI | 12 e2e, `ci.yml` |

---

### Задача 1: Каркас монорепо

**Files:**
- Create (из `shadcn init`): `apps/web/*`, `packages/ui/*`, `turbo.json`, `tsconfig.json`, `.prettierrc`, `.npmrc`, `AGENTS.md`
- Create: `pnpm-workspace.yaml`, `tsconfig.node.json`, `eslint.config.js`, `.prettierignore`
- Modify: `.gitignore`, `package.json`, `apps/web/package.json`, `packages/ui/src/styles/globals.css` (тема)

**Interfaces:**
- Produces: workspaces `apps/*`, `packages/*`; `tsconfig.node.json` (база серверных пакетов); алиас UI `@workspace/ui/components/<name>`; скрипты `pnpm typecheck|lint|test|e2e|build|dev`.

- [ ] **Шаг 1: Сгенерировать каркас shadcn во временной папке**

Каркас создаётся **вне** репозитория: в репо уже есть `docs/`, `.agents/`, `.claude/`, а `init` ожидает пустую папку.
`pnpm dlx` запускать системным pnpm (не 12.x): у pnpm 12 `dlx` падает с `spawn ENOEXEC` при вложенном `pnpm install` (проверено).

```bash
SCAFFOLD_DIR=$(mktemp -d)
cd "$SCAFFOLD_DIR"
pnpm dlx shadcn@latest init --name accs-manager --template vite --monorepo --preset nova --base base -y
ls accs-manager   # apps/ packages/ package.json pnpm-workspace.yaml turbo.json tsconfig.json ...
```

- [ ] **Шаг 2: Перенести каркас в репозиторий**

`.gitignore` каркаса не копируем (он игнорирует `.env*` целиком, включая `.env.example`) — свой пишем на следующем шаге.

```bash
cd /Users/nikdm/dev/_noki/accs-manager
rsync -a --exclude node_modules --exclude .git --exclude .gitignore "$SCAFFOLD_DIR/accs-manager/" ./
rm -rf "$SCAFFOLD_DIR"
```

- [ ] **Шаг 3: Корневые конфиги: .gitignore, .prettierignore, pnpm-workspace.yaml, tsconfig.node.json, eslint.config.js**

`.gitignore`

```
# secrets
.env
.env.*
!.env.example

# telegram session material — never commit
tdata-samples/
*.zip

# deps & build
node_modules/
dist/
dist-ssr/
*.tsbuildinfo
coverage/
.turbo/
*.local

# logs
logs/
*.log

# test artifacts
playwright-report/
test-results/
.vitest/

# os / editor
.DS_Store
.idea/
.vscode/*
!.vscode/extensions.json
```

`.prettierignore`

```
dist/
node_modules/
.turbo/
coverage/
pnpm-lock.yaml
.pnpm-store/
apps/web/src/routeTree.gen.ts
packages/db/drizzle/
```

pnpm 12 в CI-режиме падает на непроверенных build-скриптах (`ERR_PNPM_IGNORED_BUILDS`) — каждый разрешаем/запрещаем явно:

`pnpm-workspace.yaml`

```yaml
packages:
  - "apps/*"
  - "packages/*"

# pnpm 12 fails CI installs on unreviewed build scripts: allow or deny each explicitly
allowBuilds:
  esbuild: true
  msw: false
  # optional native deps of testcontainers (docker-modem → ssh2); not needed
  cpu-features: false
  ssh2: false
  protobufjs: false
```

База для серверных пакетов (Node 26 исполняет TS напрямую — type stripping):

`tsconfig.node.json`

```json
{
  "compilerOptions": {
    "target": "ES2024",
    "lib": ["ES2024"],
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "types": ["node"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noEmit": true,
    "allowImportingTsExtensions": true,
    "erasableSyntaxOnly": true,
    "verbatimModuleSyntax": true,
    "isolatedModules": true,
    "skipLibCheck": true,
    "resolveJsonModule": true
  }
}
```

ESLint для серверных пакетов (у `apps/web` и `packages/ui` — свои конфиги из каркаса):

`eslint.config.js`

```js
// Server-side packages (shared, db, server, api). apps/web and packages/ui keep their own configs.
import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['**/dist', '**/drizzle', 'apps/web', 'packages/ui']),
  {
    files: ['**/*.ts'],
    extends: [js.configs.recommended, tseslint.configs.recommended],
    languageOptions: { globals: globals.node },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
])
```

- [ ] **Шаг 4: package.json: pnpm 12, Node 26, ESM, скрипты; исправить no-op typecheck в web**

В каркасе `apps/web` `"typecheck": "tsc --noEmit"` ничего не проверяет (корневой tsconfig — `files: []` + references); нужен `tsc -b`.

```bash
npm pkg set packageManager=pnpm@12.8.2 type=module engines.node='>=26' \
  scripts.test='vitest run' scripts.e2e='playwright test'
(cd apps/web && npm pkg set scripts.typecheck='tsc -b')
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
pnpm --version   # 12.8.2 (corepack скачает по packageManager)
pnpm add -w -D 'vitest@^5' '@types/node@^26' 'eslint@^10' '@eslint/js@^10' 'typescript-eslint@^8' 'globals@^17'
grep -n minimumReleaseAgeExclude pnpm-workspace.yaml && echo "удалить блок minimumReleaseAgeExclude и повторить pnpm install" || true
```

Правило для всех задач: зависимости добавляются **мажорными диапазонами** (`'pkg@^N'`), pnpm 12 сам выберет последнюю версию старше `minimumReleaseAge`. Если pnpm дописал `minimumReleaseAgeExclude` — удалить и выполнить `pnpm up <pkg>`.

- [ ] **Шаг 5: Цветовая тема**

Тема по умолчанию — **blue + mist** (выбрана по превью; другая — заменить `theme`/`baseColor` в URL):

```bash
cd apps/web
npx shadcn@latest apply --preset "https://ui.shadcn.com/init?base=base&style=nova&baseColor=mist&theme=blue&iconLibrary=lucide&font=geist&radius=default&menuAccent=subtle&menuColor=default" --only theme -y
cd ../..
```

- [ ] **Шаг 6: Проверить каркас**

```bash
pnpm install
pnpm typecheck && pnpm lint && pnpm build
```

Ожидается: все turbo-задачи `successful`, `apps/web/dist` собран. Turbo создаёт `AGENTS.md` — его коммитим (иначе он появится снова).

- [ ] **Шаг 7: Commit**

```bash
git add -A
git commit -m "chore: scaffold monorepo (shadcn vite + base ui), pnpm 12, node 26 configs"
```


---

### Задача 2: `@workspace/shared`: env, длительности, шифрование

**Files:**
- Create: `packages/shared/{package.json,tsconfig.json}`, `packages/shared/src/{duration,env,crypto}.ts`, `vitest.config.ts`
- Test: `packages/shared/test/{duration,env,crypto}.test.ts`

**Interfaces:**
- Produces: `parseDuration(v: string): number`, `isDuration(v: string): boolean`, `formatDuration(ms: number): string`;
  `envSchema`, `type Env`, `loadEnv(source?): Env`; `interface Cipher { encrypt(s): string; decrypt(token): string }`, `createCipher(keyBase64): Cipher`.
  Экспорты пакета — только подпути: `@workspace/shared/{env,duration,crypto,api,events,settings}`.

- [ ] **Шаг 1: Пакет и конфиги**

`packages/shared/package.json`

```json
{
  "name": "@workspace/shared",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": {
    "./env": "./src/env.ts",
    "./duration": "./src/duration.ts",
    "./crypto": "./src/crypto.ts",
    "./api": "./src/api.ts",
    "./events": "./src/events.ts",
    "./settings": "./src/settings/index.ts"
  },
  "scripts": {
    "typecheck": "tsc -p tsconfig.json",
    "lint": "eslint ."
  },
  "dependencies": {
    "zod": "^4.6.5"
  },
  "devDependencies": {
    "@types/node": "^26.6.4",
    "typescript": "~6.0.2",
    "vitest": "^5.0.3"
  }
}
```

`test/` входит в tsconfig — иначе `expectTypeOf` в тестах не проверяется (проверено: без этого неверный тип молча проходит).

`packages/shared/tsconfig.json`

```json
{
  "extends": "../../tsconfig.node.json",
  "include": ["src", "test"]
}
```

`vitest.config.ts`

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    projects: [{ test: { name: 'shared', root: './packages/shared', environment: 'node' } }],
  },
})
```

```bash
pnpm install
```

- [ ] **Шаг 2: Написать падающие тесты**

`packages/shared/test/duration.test.ts`

```ts
import { describe, expect, it } from 'vitest'
import { formatDuration, isDuration, parseDuration } from '../src/duration.ts'

describe('duration', () => {
  it('parses all units', () => {
    expect(parseDuration('30s')).toBe(30_000)
    expect(parseDuration('5m')).toBe(300_000)
    expect(parseDuration('6h')).toBe(21_600_000)
    expect(parseDuration('7d')).toBe(604_800_000)
  })

  it('rejects malformed values', () => {
    for (const bad of ['', '5', 'm', '5 m', '1.5h', '-1m', '5M', '5min']) {
      expect(isDuration(bad)).toBe(false)
      expect(() => parseDuration(bad)).toThrow(/Invalid duration/)
    }
  })

  it('formats with the largest exact unit', () => {
    expect(formatDuration(300_000)).toBe('5m')
    expect(formatDuration(90_000)).toBe('90s')
    expect(formatDuration(86_400_000)).toBe('1d')
    expect(formatDuration(0)).toBe('0s')
  })
})
```

`packages/shared/test/env.test.ts`

```ts
import { describe, expect, it } from 'vitest'
import { loadEnv } from '../src/env.ts'

const valid = {
  DATABASE_URL: 'postgres://u:p@localhost:5432/db',
  REDIS_URL: 'redis://localhost:6379',
  APP_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
  PUBLIC_ORIGIN: 'https://panel.example.com',
}

describe('loadEnv', () => {
  it('applies defaults', () => {
    const env = loadEnv(valid)
    expect(env).toMatchObject({ NODE_ENV: 'development', PORT: 3000, TRUST_PROXY: false, LOG_LEVEL: 'info' })
  })

  it('parses TRUST_PROXY and PORT from strings', () => {
    const env = loadEnv({ ...valid, TRUST_PROXY: 'true', PORT: '8080' })
    expect(env.TRUST_PROXY).toBe(true)
    expect(env.PORT).toBe(8080)
  })

  it('rejects a key that is not 32 bytes', () => {
    expect(() => loadEnv({ ...valid, APP_ENCRYPTION_KEY: Buffer.alloc(16).toString('base64') })).toThrow(/APP_ENCRYPTION_KEY/)
  })

  it('rejects wrong URL protocols', () => {
    expect(() => loadEnv({ ...valid, DATABASE_URL: 'mysql://x' })).toThrow(/DATABASE_URL/)
    expect(() => loadEnv({ ...valid, REDIS_URL: 'http://x' })).toThrow(/REDIS_URL/)
  })

  it('reports every missing variable', () => {
    expect(() => loadEnv({})).toThrow(/DATABASE_URL[\s\S]*REDIS_URL|REDIS_URL[\s\S]*DATABASE_URL/)
  })
})
```

`packages/shared/test/crypto.test.ts`

```ts
import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { createCipher } from '../src/crypto.ts'

const key = randomBytes(32).toString('base64')

describe('createCipher', () => {
  it('round-trips text, including empty and unicode', () => {
    const c = createCipher(key)
    for (const s of ['', 'secret', 'Пароль ✓', 'x'.repeat(10_000)]) expect(c.decrypt(c.encrypt(s))).toBe(s)
  })

  it('uses the v1 format with a fresh IV each time', () => {
    const c = createCipher(key)
    const a = c.encrypt('same')
    const b = c.encrypt('same')
    expect(a).toMatch(/^v1:[^:]+:[^:]*:[^:]+$/)
    expect(a).not.toBe(b)
  })

  it('detects tampering', () => {
    const c = createCipher(key)
    const [v, iv, ct, tag] = c.encrypt('hello').split(':') as [string, string, string, string]
    const flipped = Buffer.from(ct, 'base64')
    flipped[0] = (flipped[0] ?? 0) ^ 1
    expect(() => c.decrypt([v, iv, flipped.toString('base64'), tag].join(':'))).toThrow()
  })

  it('fails with another key', () => {
    const token = createCipher(key).encrypt('hello')
    expect(() => createCipher(randomBytes(32).toString('base64')).decrypt(token)).toThrow()
  })

  it('rejects unknown versions and bad keys', () => {
    const c = createCipher(key)
    expect(() => c.decrypt('v2:a:b:c')).toThrow(/Unsupported/)
    expect(() => createCipher(randomBytes(16).toString('base64'))).toThrow(/32 bytes/)
  })
})
```

- [ ] **Шаг 3: Убедиться, что тесты падают**

```bash
npx vitest run --project shared
# FAIL: Cannot find module ../src/duration.ts (и т.д.)
```

- [ ] **Шаг 4: Реализация**

`env.ts` — только инфраструктурные переменные (спека §11); всё остальное — настройки в БД. `crypto.ts` импортируется только сервером (`@workspace/shared/crypto`).

`packages/shared/src/duration.ts`

```ts
const UNIT_MS = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const

export type DurationUnit = keyof typeof UNIT_MS

const DURATION_RE = /^(\d+)(s|m|h|d)$/

/** '5m' → 300000. Throws on invalid input. */
export function parseDuration(value: string): number {
  const match = DURATION_RE.exec(value)
  if (!match) throw new Error(`Invalid duration: "${value}" (expected e.g. 30s, 5m, 6h, 7d)`)
  return Number(match[1]) * UNIT_MS[match[2] as DurationUnit]
}

export function isDuration(value: string): boolean {
  return DURATION_RE.test(value)
}

/** 300000 → '5m'; picks the largest unit that divides evenly. */
export function formatDuration(ms: number): string {
  if (!Number.isInteger(ms) || ms < 0) throw new Error(`Invalid milliseconds: ${ms}`)
  const units: DurationUnit[] = ['d', 'h', 'm', 's']
  for (const unit of units) {
    if (ms % UNIT_MS[unit] === 0 && ms >= UNIT_MS[unit]) return `${ms / UNIT_MS[unit]}${unit}`
  }
  if (ms === 0) return '0s'
  throw new Error(`Milliseconds not representable in whole seconds: ${ms}`)
}
```

`packages/shared/src/env.ts`

```ts
import { z } from 'zod'

const base64Key32 = z
  .string()
  .refine((v) => Buffer.from(v, 'base64').length === 32, 'must be 32 bytes encoded as base64')

/** Infrastructure-only environment. Everything else lives in DB settings (spec §9). */
export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  REDIS_URL: z.url({ protocol: /^rediss?$/ }),
  APP_ENCRYPTION_KEY: base64Key32,
  PUBLIC_ORIGIN: z.url({ protocol: /^https?$/ }),
  TRUST_PROXY: z.stringbool().default(false),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
})

export type Env = z.output<typeof envSchema>

export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  const parsed = envSchema.safeParse(source)
  if (!parsed.success) {
    throw new Error(`Invalid environment:\n${z.prettifyError(parsed.error)}`)
  }
  return parsed.data
}
```

`packages/shared/src/crypto.ts`

```ts
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

const VERSION = 'v1'
const ALGORITHM = 'aes-256-gcm'

export interface Cipher {
  /** Returns `v1:<iv>:<ciphertext>:<tag>` (base64 parts). */
  encrypt(plaintext: string): string
  /** Throws if the token is malformed, uses an unknown version, or was tampered with. */
  decrypt(token: string): string
}

export function createCipher(keyBase64: string): Cipher {
  const key = Buffer.from(keyBase64, 'base64')
  if (key.length !== 32) throw new Error('APP_ENCRYPTION_KEY must be 32 bytes encoded as base64')

  return {
    encrypt(plaintext) {
      const iv = randomBytes(12)
      const cipher = createCipheriv(ALGORITHM, key, iv)
      const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
      const tag = cipher.getAuthTag()
      return [VERSION, iv.toString('base64'), ciphertext.toString('base64'), tag.toString('base64')].join(':')
    },
    decrypt(token) {
      const parts = token.split(':')
      if (parts.length !== 4 || parts[0] !== VERSION) throw new Error('Unsupported ciphertext format')
      const [, iv, ciphertext, tag] = parts as [string, string, string, string]
      const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(iv, 'base64'))
      decipher.setAuthTag(Buffer.from(tag, 'base64'))
      return Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64')), decipher.final()]).toString('utf8')
    },
  }
}
```

- [ ] **Шаг 5: Тесты, typecheck, lint**

```bash
npx vitest run --project shared   # 13 passed
pnpm --filter @workspace/shared typecheck && pnpm --filter @workspace/shared lint
```

- [ ] **Шаг 6: Commit**

```bash
git add -A && git commit -m "feat(shared): infra env schema, durations, AES-256-GCM cipher"
```


---

### Задача 3: Ядро настроек: типы, хелперы, набор v1

**Files:**
- Create: `packages/shared/src/settings/{types,helpers,groups,definitions,validate,index}.ts`
- Test: `packages/shared/test/settings.test.ts`

**Interfaces:**
- Consumes: `isDuration`, `parseDuration` (задача 2).
- Produces (`@workspace/shared/settings`): `SettingDef<T, D>`, `SettingMeta`, `SettingType`, `SettingEffect`, `SettingGroupId`, `SettingGroup`;
  хелперы `string|text|int|decimal|bool|select|multiselect|duration|secret`; `settingGroups`; `settingsDef`; `type SettingKey`; `type SettingsValues`;
  `isSettingKey(key)`, `validateSettingChanges(input): { ok: true; changes: Map<SettingKey, unknown|null> } | { ok: false; errors: Record<string,string> }`.

- [ ] **Шаг 1: Написать падающий тест (включая type-тесты)**

`packages/shared/test/settings.test.ts`

```ts
import { describe, expect, expectTypeOf, it } from 'vitest'
import {
  bool,
  decimal,
  duration,
  int,
  multiselect,
  secret,
  select,
  settingGroups,
  settingsDef,
  string,
  validateSettingChanges,
  type SettingKey,
  type SettingsValues,
} from '../src/settings/index.ts'

describe('setting helpers', () => {
  it('int enforces integer and bounds', () => {
    const d = int({ group: 'worker', label: 'x', default: 5, min: 1, max: 10 })
    expect(d.schema.safeParse(5).success).toBe(true)
    expect(d.schema.safeParse(0).success).toBe(false)
    expect(d.schema.safeParse(11).success).toBe(false)
    expect(d.schema.safeParse(1.5).success).toBe(false)
    expect(d.schema.safeParse('5').success).toBe(false)
    expect(d.meta).toMatchObject({ type: 'int', min: 1, max: 10, step: 1 })
  })

  it('decimal keeps string precision and checks scale/bounds', () => {
    const d = decimal({ group: 'worker', label: 'x', default: '0.25', min: 0, max: 1, scale: 2 })
    expect(d.schema.safeParse('0.5').success).toBe(true)
    expect(d.schema.safeParse('0.125').success).toBe(false)
    expect(d.schema.safeParse('1.01').success).toBe(false)
    expect(d.schema.safeParse(0.5).success).toBe(false)
  })

  it('duration validates format and bounds', () => {
    const d = duration({ group: 'proxy', label: 'x', default: '5m', min: '1m', max: '1h' })
    expect(d.schema.safeParse('30m').success).toBe(true)
    expect(d.schema.safeParse('30s').success).toBe(false)
    expect(d.schema.safeParse('2h').success).toBe(false)
    expect(d.schema.safeParse('5 minutes').success).toBe(false)
  })

  it('select and multiselect accept only listed options', () => {
    const options = [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }] as const
    const s = select({ group: 'proxy', label: 'x', options, default: 'a' })
    const m = multiselect({ group: 'proxy', label: 'x', options, default: ['a'] })
    expect(s.schema.safeParse('b').success).toBe(true)
    expect(s.schema.safeParse('c').success).toBe(false)
    expect(m.schema.safeParse(['a', 'b']).success).toBe(true)
    expect(m.schema.safeParse(['a', 'a']).success).toBe(false)
    expect(m.schema.safeParse(['c']).success).toBe(false)
    expectTypeOf(s.default).toEqualTypeOf<'a' | 'b'>()
  })

  it('string trims and rejects empty; bool is strict', () => {
    const s = string({ group: 'proxy', label: 'x', default: null })
    expect(s.schema.safeParse('  kz ').data).toBe('kz')
    expect(s.schema.safeParse('   ').success).toBe(false)
    const b = bool({ group: 'proxy', label: 'x', default: false })
    expect(b.schema.safeParse('true').success).toBe(false)
  })

  it('secret rejects empty string and defaults to null', () => {
    const d = secret({ group: 'notifications', label: 'x' })
    expect(d.default).toBeNull()
    expect(d.schema.safeParse('').error?.issues[0]?.message).toMatch(/Очистить/)
    expect(d.meta.type).toBe('secret')
  })

  it('throws at definition time when the default is invalid', () => {
    expect(() => int({ group: 'worker', label: 'bad', default: 0, min: 1 })).toThrow(/Default for "bad"/)
  })
})

describe('settings v1 definitions', () => {
  it('every setting belongs to a known group and has a valid default', () => {
    const groupIds = new Set<string>(settingGroups.map((g) => g.id))
    for (const [key, def] of Object.entries(settingsDef)) {
      expect(groupIds.has(def.meta.group), key).toBe(true)
      if (def.default !== null) expect(def.schema.safeParse(def.default).success, key).toBe(true)
    }
  })

  it('infers value types from definitions', () => {
    expectTypeOf<SettingsValues['worker.connectConcurrency']>().toEqualTypeOf<number>()
    expectTypeOf<SettingsValues['telegram.desktop.apiId']>().toEqualTypeOf<number | null>()
    expectTypeOf<SettingsValues['notify.botToken']>().toEqualTypeOf<string | null>()
    expectTypeOf<SettingsValues['notify.enabled']>().toEqualTypeOf<boolean>()
    expectTypeOf<SettingsValues['notify.events']>().toEqualTypeOf<
      ('code' | 'proxy_down' | 'unauthorized' | 'banned' | 'frozen' | 'proxy_expiring')[]
    >()
    expectTypeOf<'nope'>().not.toExtend<SettingKey>()
  })
})

describe('validateSettingChanges', () => {
  it('accepts valid changes and null resets', () => {
    const r = validateSettingChanges({ 'worker.connectConcurrency': 10, 'notify.botToken': null })
    expect(r.ok).toBe(true)
    if (r.ok) expect([...r.changes]).toEqual([['worker.connectConcurrency', 10], ['notify.botToken', null]])
  })

  it('is all-or-nothing and reports errors per key', () => {
    const r = validateSettingChanges({ 'worker.connectConcurrency': 10, 'proxy.checkInterval': '10s', 'no.such': 1 })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(Object.keys(r.errors).sort()).toEqual(['no.such', 'proxy.checkInterval'])
  })

  it('rejects an empty secret with a hint to use Clear', () => {
    const r = validateSettingChanges({ 'proxyStore.apiKey': '' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errors['proxyStore.apiKey']).toMatch(/Очистить/)
  })
})
```

- [ ] **Шаг 2: Убедиться, что тест падает**

```bash
npx vitest run --project shared -t settings
# FAIL: Cannot find module ../src/settings/index.ts
```

- [ ] **Шаг 3: Реализация: типы, хелперы, группы, набор v1, валидация**

Метаданные живут в типизированных объектах определений; SPA импортирует их напрямую (без `z.toJSONSchema`).
`null` никогда не хранится: `PATCH` с `null` удаляет переопределение. Дефолт проверяется схемой при объявлении — опечатка в дефолте роняет импорт модуля.

`packages/shared/src/settings/types.ts`

```ts
import type { z } from 'zod'

export type SettingType =
  | 'string'
  | 'text'
  | 'int'
  | 'decimal'
  | 'bool'
  | 'select'
  | 'multiselect'
  | 'duration'
  | 'secret'

/** When a changed value takes effect; shown next to the control in the UI. */
export type SettingEffect = 'immediate' | 'new_connections' | 'restart'

export type SettingGroupId =
  | 'telegram'
  | 'notifications'
  | 'proxy'
  | 'proxyStore'
  | 'worker'
  | 'import'
  | 'retention'
  | 'security'

export interface SettingGroup {
  id: SettingGroupId
  label: string
  description: string
}

export interface SettingOption<V extends string = string> {
  value: V
  label: string
}

export interface SettingMeta {
  type: SettingType
  group: SettingGroupId
  label: string
  description?: string
  effect: SettingEffect
  /** Sort order inside the group (definition order by default). */
  order: number
  /** UI warns when a required setting has no value. Never blocks the process. */
  required: boolean
  options?: readonly SettingOption[]
  /** UI hints only — the schema is the source of truth for validation. */
  min?: number | string
  max?: number | string
  step?: number
  unit?: string
}

/**
 * T — type of a value the admin can set (validated by `schema`).
 * D — type of the default; `null` means "not set" (no override row, feature may be off).
 * `null` is never stored: PATCH with `null` removes the override.
 */
export interface SettingDef<T = unknown, D extends T | null = T | null> {
  readonly schema: z.ZodType<T>
  readonly default: D
  readonly meta: SettingMeta
}

export type SettingValueOf<S> = S extends SettingDef<infer T, infer D> ? T | D : never
```

`packages/shared/src/settings/helpers.ts`

```ts
import { z } from 'zod'
import { isDuration, parseDuration } from '../duration.ts'
import type { SettingDef, SettingEffect, SettingGroupId, SettingMeta, SettingOption, SettingType } from './types.ts'

interface CommonOpts {
  group: SettingGroupId
  label: string
  description?: string
  effect?: SettingEffect
  required?: boolean
}

let orderCounter = 0

function meta(type: SettingType, o: CommonOpts, extra: Partial<SettingMeta> = {}): SettingMeta {
  return {
    type,
    group: o.group,
    label: o.label,
    ...(o.description === undefined ? {} : { description: o.description }),
    effect: o.effect ?? 'immediate',
    order: orderCounter++,
    required: o.required ?? false,
    ...extra,
  }
}

function make<T, D extends T | null>(schema: z.ZodType<T>, defaultValue: D, m: SettingMeta): SettingDef<T, D> {
  if (defaultValue !== null) {
    const check = schema.safeParse(defaultValue)
    if (!check.success) throw new Error(`Default for "${m.label}" is invalid: ${z.prettifyError(check.error)}`)
  }
  return { schema, default: defaultValue, meta: m }
}

const NON_EMPTY = 'Не может быть пустым'

export function string<const D extends string | null>(
  o: CommonOpts & { default: D; pattern?: RegExp; patternMessage?: string; maxLength?: number },
): SettingDef<string, D> {
  let schema = z.string().trim().min(1, NON_EMPTY).max(o.maxLength ?? 500)
  if (o.pattern) schema = schema.regex(o.pattern, o.patternMessage ?? 'Неверный формат')
  return make(schema, o.default, meta('string', o))
}

export function text<const D extends string | null>(
  o: CommonOpts & { default: D; maxLength?: number },
): SettingDef<string, D> {
  const schema = z.string().trim().min(1, NON_EMPTY).max(o.maxLength ?? 10_000)
  return make(schema, o.default, meta('text', o))
}

export function int<const D extends number | null>(
  o: CommonOpts & { default: D; min?: number; max?: number; unit?: string },
): SettingDef<number, D> {
  let schema = z.number({ error: 'Нужно целое число' }).int('Нужно целое число')
  if (o.min !== undefined) schema = schema.min(o.min, `Не меньше ${o.min}`)
  if (o.max !== undefined) schema = schema.max(o.max, `Не больше ${o.max}`)
  return make(
    schema,
    o.default,
    meta('int', o, { step: 1, ...pick(o, ['min', 'max', 'unit']) }),
  )
}

/** Decimal values travel as strings to avoid float rounding (e.g. "0.25"). */
export function decimal<const D extends string | null>(
  o: CommonOpts & { default: D; min?: number; max?: number; scale?: number; unit?: string },
): SettingDef<string, D> {
  const scale = o.scale ?? 2
  const re = new RegExp(`^-?\\d+(\\.\\d{1,${scale}})?$`)
  const schema = z
    .string()
    .regex(re, `Число с не более чем ${scale} знаками после точки`)
    .refine((v) => o.min === undefined || Number(v) >= o.min, `Не меньше ${o.min}`)
    .refine((v) => o.max === undefined || Number(v) <= o.max, `Не больше ${o.max}`)
  return make(
    schema,
    o.default,
    meta('decimal', o, { step: 10 ** -scale, ...pick(o, ['min', 'max', 'unit']) }),
  )
}

export function bool(o: CommonOpts & { default: boolean }): SettingDef<boolean, boolean> {
  return make(z.boolean({ error: 'Нужно да/нет' }), o.default, meta('bool', o))
}

export function select<const V extends string>(
  o: CommonOpts & { options: readonly SettingOption<V>[]; default: NoInfer<V> },
): SettingDef<V, V> {
  const values = o.options.map((x) => x.value) as [V, ...V[]]
  return make(z.enum(values, { error: 'Выберите значение из списка' }) as unknown as z.ZodType<V>, o.default, meta('select', o, { options: o.options }))
}

export function multiselect<const V extends string>(
  o: CommonOpts & { options: readonly SettingOption<V>[]; default: NoInfer<V>[] },
): SettingDef<V[], V[]> {
  const values = o.options.map((x) => x.value) as [V, ...V[]]
  const schema = z
    .array(z.enum(values, { error: 'Недопустимое значение' }))
    .refine((arr) => new Set(arr).size === arr.length, 'Значения не должны повторяться')
  return make(schema as unknown as z.ZodType<V[]>, o.default, meta('multiselect', o, { options: o.options }))
}

/** Durations are strings like "30s", "5m", "6h", "7d"; consumers use parseDuration(). */
export function duration<const D extends string | null>(
  o: CommonOpts & { default: D; min?: string; max?: string },
): SettingDef<string, D> {
  const minMs = o.min === undefined ? undefined : parseDuration(o.min)
  const maxMs = o.max === undefined ? undefined : parseDuration(o.max)
  const schema = z
    .string()
    .refine(isDuration, 'Формат: число и единица — 30s, 5m, 6h, 7d')
    .refine((v) => !isDuration(v) || minMs === undefined || parseDuration(v) >= minMs, `Не меньше ${o.min}`)
    .refine((v) => !isDuration(v) || maxMs === undefined || parseDuration(v) <= maxMs, `Не больше ${o.max}`)
  return make(schema, o.default, meta('duration', o, pick(o, ['min', 'max'])))
}

/** Stored encrypted; the API never returns the value, only whether it is set. */
export function secret(o: CommonOpts): SettingDef<string, null> {
  const schema = z.string().min(1, 'Пустое значение — используйте «Очистить»').max(4096)
  return make(schema, null, meta('secret', o))
}

function pick<T extends object, K extends keyof T>(obj: T, keys: K[]): Partial<Pick<T, K>> {
  const out: Partial<Pick<T, K>> = {}
  for (const k of keys) if (obj[k] !== undefined) out[k] = obj[k]
  return out
}
```

`packages/shared/src/settings/groups.ts`

```ts
import type { SettingGroup } from './types.ts'

export const settingGroups = [
  { id: 'telegram', label: 'Telegram', description: 'Профили клиента MTProto: api_id и параметры устройства.' },
  { id: 'notifications', label: 'Уведомления', description: 'Дублирование кодов и предупреждений в Telegram-канал через Bot API.' },
  { id: 'proxy', label: 'Прокси', description: 'Проверка здоровья пула прокси.' },
  { id: 'proxyStore', label: 'proxy-store', description: 'Автосинхронизация прокси с proxy-store.com.' },
  { id: 'worker', label: 'Воркер', description: 'Подключение и обслуживание клиентов аккаунтов.' },
  { id: 'import', label: 'Импорт', description: 'Ограничения при загрузке zip с tdata.' },
  { id: 'retention', label: 'Хранение', description: 'Сколько хранить данные.' },
  { id: 'security', label: 'Безопасность', description: 'Сессии админов и защита входа.' },
] as const satisfies readonly SettingGroup[]
```

`packages/shared/src/settings/definitions.ts`

```ts
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
```

`packages/shared/src/settings/validate.ts`

```ts
import { settingsDef, type SettingKey } from './definitions.ts'

export type SettingChangeResult =
  | { ok: true; changes: Map<SettingKey, unknown | null> }
  | { ok: false; errors: Record<string, string> }

export function isSettingKey(key: string): key is SettingKey {
  return Object.hasOwn(settingsDef, key)
}

/**
 * Validates a PATCH payload. `null` = remove the override (back to default / clear secret).
 * All-or-nothing: any error → nothing is applied.
 */
export function validateSettingChanges(input: Record<string, unknown>): SettingChangeResult {
  const errors: Record<string, string> = {}
  const changes = new Map<SettingKey, unknown | null>()
  for (const [key, value] of Object.entries(input)) {
    if (!isSettingKey(key)) {
      errors[key] = 'Неизвестная настройка'
      continue
    }
    if (value === null) {
      changes.set(key, null)
      continue
    }
    const parsed = settingsDef[key].schema.safeParse(value)
    if (parsed.success) changes.set(key, parsed.data)
    else errors[key] = parsed.error.issues[0]?.message ?? 'Неверное значение'
  }
  return Object.keys(errors).length > 0 ? { ok: false, errors } : { ok: true, changes }
}
```

`packages/shared/src/settings/index.ts`

```ts
export * from './types.ts'
export * from './helpers.ts'
export * from './groups.ts'
export * from './definitions.ts'
export * from './validate.ts'
```

- [ ] **Шаг 4: Тесты и typecheck (type-тесты проверяет именно tsc)**

```bash
npx vitest run --project shared   # 25 passed
pnpm --filter @workspace/shared typecheck && pnpm --filter @workspace/shared lint
```

- [ ] **Шаг 5: Commit**

```bash
git add -A && git commit -m "feat(shared): typed settings registry (zod 4) with v1 definitions"
```


---

### Задача 4: `@workspace/db`: схема, миграции, тестовая инфраструктура

**Files:**
- Create: `packages/db/{package.json,tsconfig.json,drizzle.config.ts}`, `packages/db/src/{schema,client,migrate,migrate-cli,index,testing}.ts`, `packages/db/drizzle/*` (генерируется), `vitest.global-setup.ts`
- Modify: `vitest.config.ts`, корневой `package.json` (testcontainers)
- Test: `packages/db/test/schema.test.ts`

**Interfaces:**
- Produces: `createDb(url, { max? }): DbHandle` (`{ db: Db; pool; close() }`), `type Db`; `runMigrations(db)`; таблицы `admins`, `adminSessions`, `auditLog`, `settings`;
  `createTestDatabase(adminUrl): Promise<TestDatabase>` (`DbHandle & { url; drop() }`); `inject('pgAdminUrl' | 'redisUrl')` в тестах.

- [ ] **Шаг 1: Пакет, drizzle.config, глобальный setup тестов**

`packages/db/package.json`

```json
{
  "name": "@workspace/db",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./src/index.ts",
    "./schema": "./src/schema.ts",
    "./testing": "./src/testing.ts"
  },
  "scripts": {
    "typecheck": "tsc -p tsconfig.json",
    "db:generate": "drizzle-kit generate",
    "db:migrate": "node --env-file-if-exists=../../.env src/migrate-cli.ts",
    "lint": "eslint ."
  },
  "dependencies": {
    "drizzle-orm": "^0.45.3",
    "pg": "^8.23.1"
  },
  "devDependencies": {
    "@types/node": "^26.6.4",
    "@types/pg": "^8.23.1",
    "drizzle-kit": "^0.31.11",
    "typescript": "~6.0.3",
    "vitest": "^5.0.3"
  }
}
```

`packages/db/tsconfig.json`

```json
{
  "extends": "../../tsconfig.node.json",
  "include": ["src", "test", "drizzle.config.ts"]
}
```

`packages/db/drizzle.config.ts`

```ts
import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema.ts',
  out: './drizzle',
})
```

Testcontainers поднимает Postgres 18 и Redis 8 **один раз** на прогон; в CI вместо них — сервисы через `TEST_PG_URL`/`TEST_REDIS_URL`.

`vitest.global-setup.ts`

```ts
import { PostgreSqlContainer } from '@testcontainers/postgresql'
import { RedisContainer } from '@testcontainers/redis'
import type { TestProject } from 'vitest/node'
import type {} from './packages/db/src/testing.ts'

/**
 * One Postgres 18 + Redis 8 for the whole run. In CI, service containers are passed via
 * TEST_PG_URL / TEST_REDIS_URL and testcontainers is skipped.
 */
export default async function setup(project: TestProject) {
  if (process.env.TEST_PG_URL && process.env.TEST_REDIS_URL) {
    project.provide('pgAdminUrl', process.env.TEST_PG_URL)
    project.provide('redisUrl', process.env.TEST_REDIS_URL)
    return
  }
  const [pg, redis] = await Promise.all([
    new PostgreSqlContainer('postgres:18-trixie').start(),
    new RedisContainer('redis:8-trixie').start(),
  ])
  project.provide('pgAdminUrl', pg.getConnectionUri())
  project.provide('redisUrl', redis.getConnectionUrl())
  return async () => {
    await Promise.all([pg.stop(), redis.stop()])
  }
}
```

`vitest.config.ts`

```ts
import { defineConfig } from 'vitest/config'

const integration = { testTimeout: 30_000, hookTimeout: 120_000 }

export default defineConfig({
  test: {
    // starts Postgres 18 + Redis 8 once for the whole run; URLs reach every project via provide/inject
    globalSetup: ['./vitest.global-setup.ts'],
    projects: [
      { test: { name: 'shared', root: './packages/shared', environment: 'node' } },
      { test: { name: 'db', root: './packages/db', environment: 'node', ...integration } },
    ],
  },
})
```

```bash
pnpm add -w -D '@testcontainers/postgresql@^12' '@testcontainers/redis@^12'
pnpm install
```

- [ ] **Шаг 2: Написать падающий тест**

`packages/db/test/schema.test.ts`

```ts
import { eq, sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'
import { admins, adminSessions, settings } from '../src/index.ts'
import { createTestDatabase, type TestDatabase } from '../src/testing.ts'

let t: TestDatabase

beforeAll(async () => {
  t = await createTestDatabase(inject('pgAdminUrl'))
})
afterAll(async () => {
  await t.drop()
})

describe('schema', () => {
  it('applies migrations idempotently', async () => {
    const { runMigrations } = await import('../src/migrate.ts')
    await runMigrations(t.db)
    const res = await t.db.execute(sql`select count(*)::int as n from information_schema.tables where table_schema = 'public'`)
    expect(res.rows[0]).toEqual({ n: 4 })
  })

  it('enforces unique admin login', async () => {
    await t.db.insert(admins).values({ login: 'alice', passwordHash: 'h' })
    await expect(t.db.insert(admins).values({ login: 'alice', passwordHash: 'h2' })).rejects.toThrow()
  })

  it('cascades sessions when an admin is deleted', async () => {
    const [a] = await t.db.insert(admins).values({ login: 'bob', passwordHash: 'h' }).returning()
    await t.db.insert(adminSessions).values({ adminId: a!.id, tokenHash: 'x', expiresAt: new Date(Date.now() + 1000) })
    await t.db.delete(admins).where(eq(admins.id, a!.id))
    expect(await t.db.select().from(adminSessions).where(eq(adminSessions.adminId, a!.id))).toEqual([])
  })

  it('stores arbitrary JSON in settings', async () => {
    await t.db.insert(settings).values({ key: 'k', value: { enc: 'v1:a:b:c' } })
    await t.db
      .insert(settings)
      .values({ key: 'k', value: [1, 2] })
      .onConflictDoUpdate({ target: settings.key, set: { value: [1, 2], updatedAt: new Date() } })
    const [row] = await t.db.select().from(settings).where(eq(settings.key, 'k'))
    expect(row?.value).toEqual([1, 2])
  })
})
```

- [ ] **Шаг 3: Убедиться, что тест падает**

```bash
npx vitest run --project db
# FAIL: Cannot find module ../src/index.ts
```

- [ ] **Шаг 4: Схема, клиент, миграции, хелпер тестовой БД**

`testing.ts` создаёт отдельную мигрированную базу на каждый тестовый файл и объявляет типы `ProvidedContext` (их видят все пакеты, импортирующие `@workspace/db/testing`).

`packages/db/src/schema.ts`

```ts
import { bigserial, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'

const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow()

export const admins = pgTable(
  'admins',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    login: text('login').notNull(),
    passwordHash: text('password_hash').notNull(),
    disabledAt: timestamp('disabled_at', { withTimezone: true }),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('admins_login_key').on(t.login)],
)

export const adminSessions = pgTable(
  'admin_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tokenHash: text('token_hash').notNull(),
    adminId: uuid('admin_id')
      .notNull()
      .references(() => admins.id, { onDelete: 'cascade' }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    ip: text('ip'),
    userAgent: text('user_agent'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('admin_sessions_token_hash_key').on(t.tokenHash), index('admin_sessions_admin_id_idx').on(t.adminId)],
)

export const auditLog = pgTable(
  'audit_log',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    actorType: text('actor_type', { enum: ['admin', 'system', 'cli'] }).notNull(),
    adminId: uuid('admin_id').references(() => admins.id, { onDelete: 'set null' }),
    action: text('action').notNull(),
    targetType: text('target_type'),
    targetId: text('target_id'),
    payload: jsonb('payload').$type<unknown>(),
    ip: text('ip'),
    userAgent: text('user_agent'),
    statusCode: integer('status_code'),
    result: text('result', { enum: ['ok', 'error'] }).notNull(),
    durationMs: integer('duration_ms'),
    createdAt: createdAt(),
  },
  (t) => [
    index('audit_log_created_at_idx').on(t.createdAt),
    index('audit_log_admin_id_idx').on(t.adminId),
    index('audit_log_action_idx').on(t.action),
  ],
)

export const settings = pgTable('settings', {
  key: text('key').primaryKey(),
  /** plain JSON value, or { enc: "v1:..." } for secrets */
  value: jsonb('value').$type<unknown>().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  updatedBy: uuid('updated_by').references(() => admins.id, { onDelete: 'set null' }),
})
```

`packages/db/src/client.ts`

```ts
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import pg from 'pg'
import * as schema from './schema.ts'

export type Db = NodePgDatabase<typeof schema>

export interface DbHandle {
  db: Db
  pool: pg.Pool
  close(): Promise<void>
}

export function createDb(url: string, options: { max?: number } = {}): DbHandle {
  const pool = new pg.Pool({ connectionString: url, max: options.max ?? 10 })
  const db = drizzle({ client: pool, schema })
  return { db, pool, close: () => pool.end() }
}
```

`packages/db/src/migrate.ts`

```ts
import { fileURLToPath } from 'node:url'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import type { Db } from './client.ts'

export const migrationsFolder = fileURLToPath(new URL('../drizzle', import.meta.url))

export async function runMigrations(db: Db): Promise<void> {
  await migrate(db, { migrationsFolder })
}
```

`packages/db/src/migrate-cli.ts`

```ts
import { createDb } from './client.ts'
import { runMigrations } from './migrate.ts'

const url = process.env.DATABASE_URL
if (!url) {
  console.error('DATABASE_URL is required')
  process.exit(1)
}

const handle = createDb(url, { max: 1 })
try {
  await runMigrations(handle.db)
  console.log('migrations applied')
} finally {
  await handle.close()
}
```

`packages/db/src/index.ts`

```ts
export * from './client.ts'
export * from './migrate.ts'
export * as schema from './schema.ts'
export { admins, adminSessions, auditLog, settings } from './schema.ts'
```

`packages/db/src/testing.ts`

```ts
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { createDb, type DbHandle } from './client.ts'
import { runMigrations } from './migrate.ts'

declare module 'vitest' {
  export interface ProvidedContext {
    /** superuser URL of the shared test Postgres (see vitest.global-setup.ts) */
    pgAdminUrl: string
    redisUrl: string
  }
}

export interface TestDatabase extends DbHandle {
  url: string
  drop(): Promise<void>
}

async function adminQuery(adminUrl: string, sql: string): Promise<void> {
  const client = new pg.Client({ connectionString: adminUrl })
  await client.connect()
  try {
    await client.query(sql)
  } finally {
    await client.end()
  }
}

/** Creates an isolated, migrated database for one test file. */
export async function createTestDatabase(adminUrl: string): Promise<TestDatabase> {
  const name = `t_${randomUUID().replaceAll('-', '')}`
  await adminQuery(adminUrl, `CREATE DATABASE ${name}`)
  const url = new URL(adminUrl)
  url.pathname = `/${name}`
  const handle = createDb(url.toString(), { max: 5 })
  await runMigrations(handle.db)
  return {
    ...handle,
    url: url.toString(),
    async drop() {
      await handle.close()
      await adminQuery(adminUrl, `DROP DATABASE ${name} WITH (FORCE)`)
    },
  }
}
```

- [ ] **Шаг 5: Сгенерировать первую миграцию**

```bash
cd packages/db && pnpm db:generate --name init && cd ../..
ls packages/db/drizzle   # 0000_init.sql  meta/
```

Ожидается вывод `4 tables` (admin_sessions, admins, audit_log, settings).

- [ ] **Шаг 6: Тесты**

```bash
npx vitest run --project db   # 4 passed
pnpm --filter @workspace/db typecheck && pnpm --filter @workspace/db lint
```

- [ ] **Шаг 7: Commit**

```bash
git add -A && git commit -m "feat(db): drizzle schema (admins, sessions, audit, settings), migrations, test db helper"
```


---

### Задача 5: `@workspace/server`: логгер, Redis, шина событий

**Files:**
- Create: `packages/shared/src/events.ts`, `packages/server/{package.json,tsconfig.json}`, `packages/server/src/{logger,redis,bus,index}.ts`
- Modify: `vitest.config.ts`
- Test: `packages/server/test/bus.test.ts`

**Interfaces:**
- Produces: `EVENTS_CHANNEL`, `appEventSchema`, `type AppEvent` (`{ type: 'settings.changed'; keys: string[]; by: string | null }`);
  `createLogger({ level, pretty?, name? }): Logger`; `createRedis(url, name, logger?): Redis`;
  `createEventBus({ publisher, subscriber, channel?, logger? }): Promise<EventBus>` (`publish(event)`, `subscribe(handler) => unsubscribe`, `close()`).

- [ ] **Шаг 1: Пакет**

`packages/server/package.json`

```json
{
  "name": "@workspace/server",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./src/index.ts"
  },
  "scripts": {
    "typecheck": "tsc -p tsconfig.json",
    "lint": "eslint ."
  },
  "dependencies": {
    "@workspace/db": "workspace:*",
    "@workspace/shared": "workspace:*",
    "drizzle-orm": "^0.45.3",
    "ioredis": "^6.0.0",
    "pino": "^10.3.1",
    "zod": "^4.6.5"
  },
  "devDependencies": {
    "@types/node": "^26.6.4",
    "pino-pretty": "^13.1.3",
    "typescript": "~6.0.3",
    "vitest": "^5.0.3"
  }
}
```

`packages/server/tsconfig.json`

```json
{
  "extends": "../../tsconfig.node.json",
  "include": ["src", "test"]
}
```

`vitest.config.ts`

```ts
import { defineConfig } from 'vitest/config'

const integration = { testTimeout: 30_000, hookTimeout: 120_000 }

export default defineConfig({
  test: {
    // starts Postgres 18 + Redis 8 once for the whole run; URLs reach every project via provide/inject
    globalSetup: ['./vitest.global-setup.ts'],
    projects: [
      { test: { name: 'shared', root: './packages/shared', environment: 'node' } },
      { test: { name: 'db', root: './packages/db', environment: 'node', ...integration } },
      { test: { name: 'server', root: './packages/server', environment: 'node', ...integration } },
    ],
  },
})
```

```bash
pnpm install
```

- [ ] **Шаг 2: Написать падающий тест**

`packages/server/test/bus.test.ts`

```ts
import { randomUUID } from 'node:crypto'
// typed inject('redisUrl'): the ProvidedContext augmentation lives in the test-db helper
import type {} from '@workspace/db/testing'
import { afterAll, describe, expect, inject, it, vi } from 'vitest'
import { createEventBus } from '../src/bus.ts'
import { createRedis } from '../src/redis.ts'

const url = inject('redisUrl')
const conns = [createRedis(url, 'a-pub'), createRedis(url, 'a-sub'), createRedis(url, 'b-pub'), createRedis(url, 'b-sub')]
afterAll(async () => {
  await Promise.all(conns.map((c) => c.quit()))
})

describe('event bus', () => {
  it('delivers typed events across instances and drops invalid payloads', async () => {
    const channel = `test:${randomUUID()}`
    const [aPub, aSub, bPub, bSub] = conns as [typeof conns[0], typeof conns[0], typeof conns[0], typeof conns[0]]
    const a = await createEventBus({ publisher: aPub, subscriber: aSub, channel })
    const b = await createEventBus({ publisher: bPub, subscriber: bSub, channel })
    const received = vi.fn()
    b.subscribe(received)

    await aPub.publish(channel, 'not json')
    await aPub.publish(channel, JSON.stringify({ type: 'unknown' }))
    await a.publish({ type: 'settings.changed', keys: ['notify.enabled'], by: null })

    await vi.waitFor(() => expect(received).toHaveBeenCalledTimes(1))
    expect(received).toHaveBeenCalledWith({ type: 'settings.changed', keys: ['notify.enabled'], by: null })
    await a.close()
    await b.close()
  })
})
```

- [ ] **Шаг 3: Убедиться, что тест падает**

```bash
npx vitest run --project server
# FAIL: Cannot find module ../src/bus.ts
```

- [ ] **Шаг 4: Контракт событий, логгер, Redis, шина**

ioredis 6 — только именованный импорт `{ Redis }`; обработчик `error` обязателен (иначе спам «Unhandled error event»).
Подписчику нужно отдельное соединение; соединениями владеет вызывающий код.

`packages/shared/src/events.ts`

```ts
import { z } from 'zod'

/** Redis pub/sub channel shared by api and worker; also the source of the SSE stream. */
export const EVENTS_CHANNEL = 'accs:events'

export const appEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('settings.changed'),
    keys: z.array(z.string()),
    /** admin id, or null for CLI/system */
    by: z.string().nullable(),
  }),
])

export type AppEvent = z.output<typeof appEventSchema>
export type AppEventType = AppEvent['type']
```

`packages/server/src/logger.ts`

```ts
import { pino, type Logger } from 'pino'

export type { Logger }

/** Paths censored in every log line. Values never reach stdout. */
export const REDACT_PATHS = [
  'password',
  '*.password',
  'passcode',
  '*.passcode',
  'token',
  '*.token',
  '*.apiHash',
  '*.apiKey',
  '*.botToken',
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
]

export function createLogger(options: { level: string; pretty?: boolean; name?: string }): Logger {
  return pino({
    level: options.level,
    ...(options.name === undefined ? {} : { name: options.name }),
    redact: { paths: REDACT_PATHS, censor: '[redacted]' },
    ...(options.pretty ? { transport: { target: 'pino-pretty', options: { colorize: true } } } : {}),
  })
}
```

`packages/server/src/redis.ts`

```ts
import { Redis } from 'ioredis'
import type { Logger } from './logger.ts'

export type { Redis }

/**
 * `name` shows up in `CLIENT LIST`. An 'error' listener is always attached: without one ioredis
 * prints "Unhandled error event" on every reconnect attempt.
 */
export function createRedis(url: string, name: string, logger?: Logger): Redis {
  const redis = new Redis(url, { connectionName: name })
  redis.on('error', (err: Error) => logger?.warn({ err, connection: name }, 'redis: connection error'))
  return redis
}
```

`packages/server/src/bus.ts`

```ts
import { appEventSchema, EVENTS_CHANNEL, type AppEvent } from '@workspace/shared/events'
import type { Redis } from 'ioredis'
import type { Logger } from './logger.ts'

export type EventHandler = (event: AppEvent) => void

export interface EventBus {
  publish(event: AppEvent): Promise<void>
  /** Returns an unsubscribe function. */
  subscribe(handler: EventHandler): () => void
  close(): Promise<void>
}

/**
 * Typed pub/sub over one Redis channel. `subscriber` must be a dedicated connection
 * (a subscribed ioredis client cannot run other commands). Connections are owned by the caller.
 */
export async function createEventBus(options: {
  publisher: Redis
  subscriber: Redis
  channel?: string
  logger?: Logger
}): Promise<EventBus> {
  const channel = options.channel ?? EVENTS_CHANNEL
  const handlers = new Set<EventHandler>()

  const onMessage = (ch: string, raw: string) => {
    if (ch !== channel) return
    let event: AppEvent
    try {
      const parsed = appEventSchema.safeParse(JSON.parse(raw))
      if (!parsed.success) {
        options.logger?.warn({ raw }, 'bus: dropping invalid event')
        return
      }
      event = parsed.data
    } catch {
      options.logger?.warn({ raw }, 'bus: dropping non-JSON message')
      return
    }
    for (const handler of handlers) {
      try {
        handler(event)
      } catch (err) {
        options.logger?.error({ err, type: event.type }, 'bus: handler failed')
      }
    }
  }

  options.subscriber.on('message', onMessage)
  await options.subscriber.subscribe(channel)

  return {
    async publish(event) {
      await options.publisher.publish(channel, JSON.stringify(appEventSchema.parse(event)))
    },
    subscribe(handler) {
      handlers.add(handler)
      return () => {
        handlers.delete(handler)
      }
    },
    async close() {
      handlers.clear()
      options.subscriber.off('message', onMessage)
      await options.subscriber.unsubscribe(channel)
    },
  }
}
```

`packages/server/src/index.ts`

```ts
export * from './bus.ts'
export * from './logger.ts'
export * from './redis.ts'
```

- [ ] **Шаг 5: Тесты**

```bash
npx vitest run --project server   # 1 passed
pnpm --filter @workspace/server typecheck && pnpm --filter @workspace/server lint
```

- [ ] **Шаг 6: Commit**

```bash
git add -A && git commit -m "feat(server): logger, redis factory, typed pub/sub event bus"
```


---

### Задача 6: SettingsService: хранение, шифрование секретов, применение без перезапуска

**Files:**
- Create: `packages/shared/src/api.ts`, `packages/server/src/settings-service.ts`
- Modify: `packages/server/src/index.ts`
- Test: `packages/server/test/settings-service.test.ts`

**Interfaces:**
- Consumes: `settingsDef`, `validateSettingChanges` (3), `settings` table, `Db` (4), `EventBus` (5), `Cipher` (2).
- Produces: `SettingsService.create({ db, cipher, bus, logger? })`; `get<K>(key): SettingsValues[K]`; `onChange(key, (value, prev) => void) => unsubscribe`;
  `snapshot(): Record<SettingKey, SettingStateDto>`; `update(input, { adminId }): Promise<{ ok: true; diff: SettingDiff[] } | { ok: false; errors }>`; `reload()`; `close()`.
  Из `@workspace/shared/api`: `loginInput`, `changePasswordInput`, `meResponse`, `adminDto`, `createAdminInput`, `resetPasswordInput`, `auditQuery`, `auditEntryDto`, `auditPage`,
  `settingStateDto`, `settingsResponse`, `settingsPatchInput`, `loginSchema`, `passwordSchema` и их типы.

- [ ] **Шаг 1: Написать падающий тест**

`packages/server/test/settings-service.test.ts`

```ts
import { randomBytes, randomUUID } from 'node:crypto'
import { settings as settingsTable } from '@workspace/db'
import { createTestDatabase, type TestDatabase } from '@workspace/db/testing'
import { createCipher } from '@workspace/shared/crypto'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it, vi } from 'vitest'
import { createEventBus, type EventBus } from '../src/bus.ts'
import { createRedis, type Redis } from '../src/redis.ts'
import { SettingsService } from '../src/settings-service.ts'

const cipher = createCipher(randomBytes(32).toString('base64'))
let t: TestDatabase
const redis: Redis[] = []
let channel: string

async function makeBus(): Promise<EventBus> {
  const pub = createRedis(inject('redisUrl'), 'pub')
  const sub = createRedis(inject('redisUrl'), 'sub')
  redis.push(pub, sub)
  return createEventBus({ publisher: pub, subscriber: sub, channel })
}

async function makeService(): Promise<SettingsService> {
  return SettingsService.create({ db: t.db, cipher, bus: await makeBus() })
}

beforeAll(async () => {
  t = await createTestDatabase(inject('pgAdminUrl'))
})
beforeEach(async () => {
  channel = `test:${randomUUID()}`
  await t.db.delete(settingsTable)
})
afterAll(async () => {
  await Promise.all(redis.map((r) => r.quit()))
  await t.drop()
})

describe('SettingsService', () => {
  it('returns code defaults when nothing is stored', async () => {
    const s = await makeService()
    expect(s.get('worker.connectConcurrency')).toBe(5)
    expect(s.get('notify.botToken')).toBeNull()
    expect(s.snapshot()['worker.connectConcurrency']).toMatchObject({ value: 5, overridden: false, isSet: true })
  })

  it('updates, persists and reports a diff', async () => {
    const s = await makeService()
    const r = await s.update({ 'worker.connectConcurrency': 9 }, { adminId: null })
    expect(r).toEqual({ ok: true, diff: [{ key: 'worker.connectConcurrency', from: 5, to: 9 }] })
    expect(s.get('worker.connectConcurrency')).toBe(9)
    const fresh = await makeService()
    expect(fresh.get('worker.connectConcurrency')).toBe(9)
  })

  it('encrypts secrets at rest and never exposes them in the snapshot or diff', async () => {
    const s = await makeService()
    const r = await s.update({ 'notify.botToken': '123:ABC' }, { adminId: null })
    expect(r).toEqual({ ok: true, diff: [{ key: 'notify.botToken', from: '[redacted]', to: '[redacted]' }] })
    const [row] = await t.db.select().from(settingsTable).where(eq(settingsTable.key, 'notify.botToken'))
    expect(JSON.stringify(row?.value)).not.toContain('123:ABC')
    expect(row?.value).toMatchObject({ enc: expect.stringMatching(/^v1:/) })
    expect(s.get('notify.botToken')).toBe('123:ABC')
    expect(s.snapshot()['notify.botToken']).toMatchObject({ value: null, isSet: true, overridden: true })
  })

  it('null removes the override', async () => {
    const s = await makeService()
    await s.update({ 'proxy.failThreshold': 7, 'notify.botToken': 'x' }, { adminId: null })
    await s.update({ 'proxy.failThreshold': null, 'notify.botToken': null }, { adminId: null })
    expect(s.get('proxy.failThreshold')).toBe(3)
    expect(s.get('notify.botToken')).toBeNull()
    expect(await t.db.select().from(settingsTable)).toEqual([])
  })

  it('is all-or-nothing on validation errors', async () => {
    const s = await makeService()
    const r = await s.update({ 'proxy.failThreshold': 7, 'proxy.checkInterval': 'soon' }, { adminId: null })
    expect(r.ok).toBe(false)
    expect(await t.db.select().from(settingsTable)).toEqual([])
    expect(s.get('proxy.failThreshold')).toBe(3)
  })

  it('falls back to the default when a stored value no longer validates or decrypts', async () => {
    await t.db.insert(settingsTable).values([
      { key: 'worker.connectConcurrency', value: 'not-a-number' },
      { key: 'notify.botToken', value: { enc: 'v1:AAAA:AAAA:AAAA' } },
      { key: 'removed.from.code', value: 1 },
    ])
    const s = await makeService()
    expect(s.get('worker.connectConcurrency')).toBe(5)
    expect(s.get('notify.botToken')).toBeNull()
  })

  it('propagates changes to other instances and fires onChange there', async () => {
    const writer = await makeService()
    const reader = await makeService()
    const listener = vi.fn()
    reader.onChange('proxy.checkInterval', listener)
    await writer.update({ 'proxy.checkInterval': '10m' }, { adminId: null })
    await vi.waitFor(() => expect(reader.get('proxy.checkInterval')).toBe('10m'))
    expect(listener).toHaveBeenCalledWith('10m', '5m')
  })
})
```

- [ ] **Шаг 2: Убедиться, что тест падает**

```bash
npx vitest run --project server -t SettingsService
# FAIL: Cannot find module ../src/settings-service.ts
```

- [ ] **Шаг 3: DTO-контракты API и SettingsService**

`api.ts` — zod-схемы запросов/ответов, общие для api и web (понадобятся в задачах 9–16).
`SettingsService`: кеш в памяти; `update` валидирует всё, пишет одной транзакцией, перечитывает и публикует `settings.changed`;
каждый процесс перечитывает кеш по событию и вызывает `onChange`-подписчиков. Нечитаемое/невалидное сохранённое значение → умолчание + warn.

`packages/shared/src/api.ts`

```ts
import { z } from 'zod'

// ---- errors ----
export const apiErrorSchema = z.object({
  error: z.string(),
  message: z.string().optional(),
  fields: z.record(z.string(), z.string()).optional(),
})
export type ApiError = z.output<typeof apiErrorSchema>

// ---- auth ----
export const loginSchema = z.string().trim().toLowerCase().regex(/^[a-z0-9._-]{3,32}$/, 'Логин: 3–32 символа a-z, 0-9, точка, дефис, подчёркивание')
export const passwordSchema = z.string().min(10, 'Пароль не короче 10 символов').max(256)

export const loginInput = z.object({ login: z.string().trim().toLowerCase().min(1).max(64), password: z.string().min(1).max(256) })
export type LoginInput = z.output<typeof loginInput>

export const changePasswordInput = z.object({ currentPassword: z.string().min(1).max(256), newPassword: passwordSchema })
export type ChangePasswordInput = z.output<typeof changePasswordInput>

export const meResponse = z.object({ id: z.string(), login: z.string() })
export type MeResponse = z.output<typeof meResponse>

// ---- admins ----
export const adminDto = z.object({
  id: z.string(),
  login: z.string(),
  disabledAt: z.string().nullable(),
  lastLoginAt: z.string().nullable(),
  createdAt: z.string(),
})
export type AdminDto = z.output<typeof adminDto>

export const createAdminInput = z.object({ login: loginSchema, password: passwordSchema })
export type CreateAdminInput = z.output<typeof createAdminInput>

export const resetPasswordInput = z.object({ password: passwordSchema })
export type ResetPasswordInput = z.output<typeof resetPasswordInput>

// ---- audit ----
export const auditQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(10).max(100).default(50),
  adminId: z.uuid().optional(),
  action: z.string().max(100).optional(),
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
})
export type AuditQuery = z.output<typeof auditQuery>

export const auditEntryDto = z.object({
  id: z.string(),
  actorType: z.enum(['admin', 'system', 'cli']),
  adminId: z.string().nullable(),
  adminLogin: z.string().nullable(),
  action: z.string(),
  targetType: z.string().nullable(),
  targetId: z.string().nullable(),
  payload: z.unknown(),
  ip: z.string().nullable(),
  userAgent: z.string().nullable(),
  statusCode: z.number().nullable(),
  result: z.enum(['ok', 'error']),
  durationMs: z.number().nullable(),
  createdAt: z.string(),
})
export type AuditEntryDto = z.output<typeof auditEntryDto>

export const auditPage = z.object({ items: z.array(auditEntryDto), total: z.number(), page: z.number(), pageSize: z.number() })
export type AuditPage = z.output<typeof auditPage>

// ---- settings ----
export const settingStateDto = z.object({
  /** current effective value; always null for secrets */
  value: z.unknown(),
  /** secrets: whether a value is stored; others: value !== null */
  isSet: z.boolean(),
  /** an override row exists (differs from code default) */
  overridden: z.boolean(),
  updatedAt: z.string().nullable(),
  updatedBy: z.string().nullable(),
})
export type SettingStateDto = z.output<typeof settingStateDto>

export const settingsResponse = z.object({ items: z.record(z.string(), settingStateDto) })
export type SettingsResponse = z.output<typeof settingsResponse>

export const settingsPatchInput = z.object({ changes: z.record(z.string(), z.unknown()) })
export type SettingsPatchInput = z.output<typeof settingsPatchInput>
```

`packages/server/src/settings-service.ts`

```ts
import { settings as settingsTable, type Db } from '@workspace/db'
import type { SettingStateDto } from '@workspace/shared/api'
import type { Cipher } from '@workspace/shared/crypto'
import {
  isSettingKey,
  settingsDef,
  validateSettingChanges,
  type SettingKey,
  type SettingsValues,
} from '@workspace/shared/settings'
import { eq } from 'drizzle-orm'
import type { EventBus } from './bus.ts'
import type { Logger } from './logger.ts'

type Listener = (value: unknown, previous: unknown) => void

interface Entry {
  value: unknown
  overridden: boolean
  updatedAt: Date | null
  updatedBy: string | null
}

export interface SettingDiff {
  key: SettingKey
  /** secrets are reported as '[redacted]' */
  from: unknown
  to: unknown
}

export type SettingsUpdateResult = { ok: true; diff: SettingDiff[] } | { ok: false; errors: Record<string, string> }

const REDACTED = '[redacted]'
const allKeys = Object.keys(settingsDef) as SettingKey[]
const isSecret = (key: SettingKey) => settingsDef[key].meta.type === 'secret'

/**
 * Typed, DB-backed settings with an in-memory cache. Every process (api, worker) owns one
 * instance; `settings.changed` on the bus makes all instances reload, so changes apply
 * without restarts.
 */
export class SettingsService {
  readonly #db: Db
  readonly #cipher: Cipher
  readonly #bus: EventBus
  readonly #logger: Logger | undefined
  #entries = new Map<SettingKey, Entry>()
  readonly #listeners = new Map<SettingKey, Set<Listener>>()
  #unsubscribe: (() => void) | undefined

  private constructor(db: Db, cipher: Cipher, bus: EventBus, logger: Logger | undefined) {
    this.#db = db
    this.#cipher = cipher
    this.#bus = bus
    this.#logger = logger
  }

  static async create(options: { db: Db; cipher: Cipher; bus: EventBus; logger?: Logger }): Promise<SettingsService> {
    const service = new SettingsService(options.db, options.cipher, options.bus, options.logger)
    await service.reload()
    service.#unsubscribe = options.bus.subscribe((event) => {
      if (event.type !== 'settings.changed') return
      service.reload().catch((err: unknown) => service.#logger?.error({ err }, 'settings: reload failed'))
    })
    return service
  }

  get<K extends SettingKey>(key: K): SettingsValues[K] {
    return (this.#entries.get(key)?.value ?? settingsDef[key].default) as SettingsValues[K]
  }

  /** Called after a reload changes the effective value (in this process). */
  onChange<K extends SettingKey>(key: K, listener: (value: SettingsValues[K], previous: SettingsValues[K]) => void): () => void {
    const set = this.#listeners.get(key) ?? new Set<Listener>()
    set.add(listener as Listener)
    this.#listeners.set(key, set)
    return () => set.delete(listener as Listener)
  }

  /** State for the admin UI; secret values are never included. */
  snapshot(): Record<SettingKey, SettingStateDto> {
    const out = {} as Record<SettingKey, SettingStateDto>
    for (const key of allKeys) {
      const entry = this.#entries.get(key)
      const value = this.get(key)
      out[key] = {
        value: isSecret(key) ? null : value,
        isSet: value !== null,
        overridden: entry?.overridden ?? false,
        updatedAt: entry?.updatedAt?.toISOString() ?? null,
        updatedBy: entry?.updatedBy ?? null,
      }
    }
    return out
  }

  /** Validates, writes atomically, reloads and broadcasts. `null` removes the override. */
  async update(input: Record<string, unknown>, by: { adminId: string | null }): Promise<SettingsUpdateResult> {
    const validated = validateSettingChanges(input)
    if (!validated.ok) return validated

    const diff: SettingDiff[] = []
    await this.#db.transaction(async (tx) => {
      for (const [key, value] of validated.changes) {
        const from = this.get(key)
        if (value === null) {
          await tx.delete(settingsTable).where(eq(settingsTable.key, key))
        } else {
          const stored = isSecret(key) ? { enc: this.#cipher.encrypt(value as string) } : value
          await tx
            .insert(settingsTable)
            .values({ key, value: stored, updatedBy: by.adminId })
            .onConflictDoUpdate({
              target: settingsTable.key,
              set: { value: stored, updatedAt: new Date(), updatedBy: by.adminId },
            })
        }
        const to = value ?? settingsDef[key].default
        diff.push(isSecret(key) ? { key, from: REDACTED, to: to === null ? null : REDACTED } : { key, from, to })
      }
    })

    await this.reload()
    await this.#bus.publish({ type: 'settings.changed', keys: diff.map((d) => d.key), by: by.adminId })
    return { ok: true, diff }
  }

  async reload(): Promise<void> {
    const rows = await this.#db.select().from(settingsTable)
    const next = new Map<SettingKey, Entry>()
    for (const row of rows) {
      if (!isSettingKey(row.key)) continue
      const value = this.#decode(row.key, row.value)
      if (value === undefined) continue
      next.set(row.key, { value, overridden: true, updatedAt: row.updatedAt, updatedBy: row.updatedBy })
    }
    const previous = this.#entries
    this.#entries = next
    for (const key of allKeys) {
      const before = previous.get(key)?.value ?? settingsDef[key].default
      const after = next.get(key)?.value ?? settingsDef[key].default
      if (JSON.stringify(before) === JSON.stringify(after)) continue
      for (const listener of this.#listeners.get(key) ?? []) {
        try {
          listener(after, before)
        } catch (err) {
          this.#logger?.error({ err, key }, 'settings: listener failed')
        }
      }
    }
  }

  close(): void {
    this.#unsubscribe?.()
  }

  /** Returns undefined (→ default) when a stored value can't be decrypted or no longer validates. */
  #decode(key: SettingKey, stored: unknown): unknown {
    try {
      let raw = stored
      if (isSecret(key)) {
        if (typeof stored !== 'object' || stored === null || typeof (stored as { enc?: unknown }).enc !== 'string') {
          throw new Error('secret is not encrypted')
        }
        raw = this.#cipher.decrypt((stored as { enc: string }).enc)
      }
      const parsed = settingsDef[key].schema.safeParse(raw)
      if (parsed.success) return parsed.data
      this.#logger?.warn({ key }, 'settings: stored value is invalid, using default')
    } catch (err) {
      this.#logger?.warn({ key, err }, 'settings: stored value is unreadable, using default')
    }
    return undefined
  }
}
```

`packages/server/src/index.ts`

```ts
export * from './bus.ts'
export * from './logger.ts'
export * from './redis.ts'
export * from './settings-service.ts'
```

- [ ] **Шаг 4: Тесты**

```bash
npx vitest run --project server   # 8 passed
pnpm typecheck && pnpm lint
```

- [ ] **Шаг 5: Commit**

```bash
git add -A && git commit -m "feat(server): DB-backed typed SettingsService with encrypted secrets and live reload"
```


---

### Задача 7: Запись аудита и санитайзер

**Files:**
- Create: `packages/server/src/audit.ts`
- Modify: `packages/server/src/index.ts`
- Test: `packages/server/test/audit.test.ts`

**Interfaces:**
- Produces: `type AuditActor = { type: 'admin'; adminId: string | null } | { type: 'system' } | { type: 'cli' }`;
  `interface AuditRecord`; `sanitizeForAudit(value): unknown`; `writeAudit(db, record): Promise<void>`.

- [ ] **Шаг 1: Написать падающий тест**

`packages/server/test/audit.test.ts`

```ts
import { auditLog } from '@workspace/db'
import { createTestDatabase, type TestDatabase } from '@workspace/db/testing'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'
import { sanitizeForAudit, writeAudit } from '../src/audit.ts'

let t: TestDatabase
beforeAll(async () => {
  t = await createTestDatabase(inject('pgAdminUrl'))
})
afterAll(async () => {
  await t.drop()
})

describe('sanitizeForAudit', () => {
  it('redacts secret-looking keys at any depth', () => {
    expect(
      sanitizeForAudit({ login: 'a', password: 'p', nested: { newPassword: 'x', apiKey: 'k', list: [{ token: 't', ok: 1 }] } }),
    ).toEqual({ login: 'a', password: '[redacted]', nested: { newPassword: '[redacted]', apiKey: '[redacted]', list: [{ token: '[redacted]', ok: 1 }] } })
  })

  it('redacts files and truncates long strings and deep objects', () => {
    const deep = { a: { b: { c: { d: { e: { f: { g: 1 } } } } } } }
    const out = sanitizeForAudit({ file: new Blob(['x']), long: 'x'.repeat(3000), deep }) as Record<string, unknown>
    expect(out.file).toBe('[redacted:file]')
    expect(String(out.long)).toMatch(/…\[truncated\]$/)
    expect(JSON.stringify(out.deep)).toContain('[truncated:depth]')
  })
})

describe('writeAudit', () => {
  it('stores a sanitized record for each actor type', async () => {
    await writeAudit(t.db, { actor: { type: 'cli' }, action: 'admin.create', payload: { login: 'x', password: 'p' }, result: 'ok' })
    await writeAudit(t.db, { actor: { type: 'system' }, action: 'settings.reload', result: 'error' })
    const rows = await t.db.select().from(auditLog).orderBy(auditLog.id)
    expect(rows.map((r) => [r.actorType, r.action, r.result, r.payload])).toEqual([
      ['cli', 'admin.create', 'ok', { login: 'x', password: '[redacted]' }],
      ['system', 'settings.reload', 'error', null],
    ])
  })
})
```

- [ ] **Шаг 2: Убедиться, что тест падает**

```bash
npx vitest run --project server -t audit
# FAIL: Cannot find module ../src/audit.ts
```

- [ ] **Шаг 3: Реализация**

Санитайзер глубокий: ключи по шаблону `password|passcode|secret|token|api_hash|api_key|auth_key|cookie|authorization` → `[redacted]`, файлы → `[redacted:file]`,
строки > 2000 символов и вложенность > 6 обрезаются. `adminId: null` — анонимный запрос (неудачный вход).

`packages/server/src/audit.ts`

```ts
import { auditLog, type Db } from '@workspace/db'

/** `adminId: null` — anonymous request (e.g. a failed login for an unknown user). */
export type AuditActor = { type: 'admin'; adminId: string | null } | { type: 'system' } | { type: 'cli' }

export interface AuditRecord {
  actor: AuditActor
  action: string
  targetType?: string | null
  targetId?: string | null
  payload?: unknown
  ip?: string | null
  userAgent?: string | null
  statusCode?: number | null
  result: 'ok' | 'error'
  durationMs?: number | null
}

const SECRET_KEY = /pass(word|code)?|secret|token|api_?hash|api_?key|auth_?key|cookie|authorization/i
const MAX_STRING = 2_000
const MAX_DEPTH = 6

/** Deep-copies `value`, replacing secret-looking keys, files and oversized strings. */
export function sanitizeForAudit(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value ?? null
  if (typeof value === 'string') return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…[truncated]` : value
  if (typeof value !== 'object') return value
  if (typeof Blob !== 'undefined' && value instanceof Blob) return '[redacted:file]'
  if (depth >= MAX_DEPTH) return '[truncated:depth]'
  if (Array.isArray(value)) return value.map((v) => sanitizeForAudit(v, depth + 1))
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value)) out[k] = SECRET_KEY.test(k) ? '[redacted]' : sanitizeForAudit(v, depth + 1)
  return out
}

export async function writeAudit(db: Db, record: AuditRecord): Promise<void> {
  await db.insert(auditLog).values({
    actorType: record.actor.type,
    adminId: record.actor.type === 'admin' ? record.actor.adminId : null,
    action: record.action,
    targetType: record.targetType ?? null,
    targetId: record.targetId ?? null,
    payload: record.payload === undefined ? null : sanitizeForAudit(record.payload),
    ip: record.ip ?? null,
    userAgent: record.userAgent ?? null,
    statusCode: record.statusCode ?? null,
    result: record.result,
    durationMs: record.durationMs ?? null,
  })
}
```

`packages/server/src/index.ts`

```ts
export * from './audit.ts'
export * from './bus.ts'
export * from './logger.ts'
export * from './redis.ts'
export * from './settings-service.ts'
```

- [ ] **Шаг 4: Тесты**

```bash
npx vitest run --project server   # 11 passed
pnpm typecheck && pnpm lint
```

- [ ] **Шаг 5: Commit**

```bash
git add -A && git commit -m "feat(server): audit writer with deep secret redaction"
```


---

### Задача 8: API: каркас Hono, healthz, защита Origin, запуск процесса

**Files:**
- Create: `apps/api/{package.json,tsconfig.json}`, `apps/api/src/{deps,app,main}.ts`, `apps/api/src/lib/client-ip.ts`, `apps/api/src/middleware/origin.ts`, `apps/api/src/routes/{health,validation}.ts`
- Modify: `vitest.config.ts`
- Test: `apps/api/test/{helpers,app.test}.ts`

**Interfaces:**
- Consumes: `loadEnv` (2), `createDb` (4), `createRedis`, `createEventBus`, `createLogger` (5), `SettingsService` (6).
- Produces: `createApp(deps: AppDeps): Hono<AppEnv>`; `type AppEnv` (Variables: `deps`, `clientIp`, `admin: SessionAdmin | null`, `sessionId`, `audit: AuditOverrides`);
  `resolveClientIp(c, trustProxy)`; `originGuard`; `validationHook` (400 `{ error: 'validation', fields }`); тестовые `setupApp(envOverrides?)`, `send(app, path, opts)`.

- [ ] **Шаг 1: Пакет и зависимости**

Сборки нет: `node src/main.ts` (Node 26 type stripping). Зависимости ставим сразу на весь API (CLI в задаче 13 использует `@inquirer/password`).

`apps/api/package.json`

```json
{
  "name": "api",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "node --watch --env-file-if-exists=../../.env src/main.ts",
    "start": "node src/main.ts",
    "cli": "node --env-file-if-exists=../../.env src/cli.ts",
    "typecheck": "tsc -p tsconfig.json",
    "lint": "eslint ."
  },
  "dependencies": {
    "@hono/node-server": "^2.1.3",
    "@hono/zod-validator": "^0.9.1",
    "@inquirer/password": "^5.2.2",
    "@workspace/db": "workspace:*",
    "@workspace/server": "workspace:*",
    "@workspace/shared": "workspace:*",
    "drizzle-orm": "^0.45.3",
    "hono": "^4.13.12",
    "ioredis": "^6.0.0",
    "zod": "^4.6.5"
  },
  "devDependencies": {
    "@types/node": "^26.6.4",
    "typescript": "~6.0.3",
    "vitest": "^5.0.3"
  }
}
```

`apps/api/tsconfig.json`

```json
{
  "extends": "../../tsconfig.node.json",
  "include": ["src", "test"]
}
```

`vitest.config.ts`

```ts
import { defineConfig } from 'vitest/config'

const integration = { testTimeout: 30_000, hookTimeout: 120_000 }

export default defineConfig({
  test: {
    // starts Postgres 18 + Redis 8 once for the whole run; URLs reach every project via provide/inject
    globalSetup: ['./vitest.global-setup.ts'],
    projects: [
      { test: { name: 'shared', root: './packages/shared', environment: 'node' } },
      { test: { name: 'db', root: './packages/db', environment: 'node', ...integration } },
      { test: { name: 'server', root: './packages/server', environment: 'node', ...integration } },
      { test: { name: 'api', root: './apps/api', environment: 'node', ...integration } },
    ],
  },
})
```

```bash
pnpm install
```

- [ ] **Шаг 2: Тестовые хелперы и падающий тест**

`send()` передаёт фейковый сокет в `c.env.incoming` — без него `getConnInfo` бросает под `app.request()`.

`apps/api/test/helpers.ts`

```ts
import { randomBytes, randomUUID } from 'node:crypto'
import { createTestDatabase, type TestDatabase } from '@workspace/db/testing'
import { createEventBus, createLogger, createRedis, SettingsService, type EventBus, type Redis } from '@workspace/server'
import { createCipher } from '@workspace/shared/crypto'
import { loadEnv, type Env } from '@workspace/shared/env'
import { inject } from 'vitest'
import { createApp } from '../src/app.ts'
import type { AppDeps } from '../src/deps.ts'

export const ORIGIN = 'https://panel.test'

export interface TestApp {
  app: ReturnType<typeof createApp>
  deps: AppDeps
  t: TestDatabase
  bus: EventBus
  close(): Promise<void>
}

export async function setupApp(envOverrides: Record<string, string> = {}): Promise<TestApp> {
  const t = await createTestDatabase(inject('pgAdminUrl'))
  const redisUrl = inject('redisUrl')
  const redis: Redis = createRedis(redisUrl, 'test')
  const sub: Redis = createRedis(redisUrl, 'test-sub')
  const bus = await createEventBus({ publisher: redis, subscriber: sub, channel: `test:${randomUUID()}` })
  const env: Env = loadEnv({
    DATABASE_URL: t.url,
    REDIS_URL: redisUrl,
    APP_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    PUBLIC_ORIGIN: ORIGIN,
    NODE_ENV: 'test',
    ...envOverrides,
  })
  const settings = await SettingsService.create({ db: t.db, cipher: createCipher(env.APP_ENCRYPTION_KEY), bus })
  const deps: AppDeps = { env, db: t.db, redis, bus, settings, logger: createLogger({ level: 'silent' }) }
  return {
    app: createApp(deps),
    deps,
    t,
    bus,
    async close() {
      settings.close()
      await bus.close()
      await Promise.allSettled([redis.quit(), sub.quit()])
      await t.drop()
    },
  }
}

export interface RequestOptions {
  method?: string
  body?: unknown
  cookie?: string
  origin?: string | null
  ip?: string
  headers?: Record<string, string>
}

/** Sends a request through the Hono app with a fake Node socket (for getConnInfo). */
export async function send(app: TestApp['app'], path: string, o: RequestOptions = {}): Promise<Response> {
  const headers = new Headers(o.headers)
  if (o.origin !== null) headers.set('origin', o.origin ?? ORIGIN)
  if (o.cookie) headers.set('cookie', o.cookie)
  let body: RequestInit['body']
  if (o.body instanceof FormData) body = o.body
  else if (o.body !== undefined) {
    headers.set('content-type', 'application/json')
    body = JSON.stringify(o.body)
  }
  return await app.request(
    path,
    { method: o.method ?? (body ? 'POST' : 'GET'), headers, ...(body ? { body } : {}) },
    { incoming: { socket: { remoteAddress: o.ip ?? '10.0.0.1' } } },
  )
}
```

`apps/api/test/app.test.ts`

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { send, setupApp, type TestApp } from './helpers.ts'

let ta: TestApp
beforeAll(async () => {
  ta = await setupApp()
})
afterAll(async () => {
  await ta.close()
})

describe('app shell', () => {
  it('reports health of Postgres and Redis', async () => {
    const res = await send(ta.app, '/api/healthz')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })

  it('rejects state-changing requests from a foreign or missing Origin', async () => {
    for (const origin of [null, 'https://evil.test']) {
      const res = await send(ta.app, '/api/anything', { method: 'POST', origin })
      expect(res.status).toBe(403)
      expect(await res.json()).toMatchObject({ error: 'forbidden' })
    }
  })
})
```

- [ ] **Шаг 3: Убедиться, что тест падает**

```bash
npx vitest run --project api
# FAIL: Cannot find module ../src/app.ts
```

- [ ] **Шаг 4: Каркас приложения**

`deps.ts` сразу объявляет все переменные контекста (`admin`, `sessionId`, `audit`) — их заполнят задачи 9–10.
Origin-guard стоит первым: изменяющий запрос без `Origin: PUBLIC_ORIGIN` → 403 ещё до авторизации.
При остановке `closeAllConnections()` обязателен — открытые SSE-потоки держат `server.close()` бесконечно.

`apps/api/src/deps.ts`

```ts
import type { Db } from '@workspace/db'
import type { EventBus, Logger, Redis, SettingsService } from '@workspace/server'
import type { Env } from '@workspace/shared/env'

export interface AppDeps {
  env: Env
  db: Db
  /** general-purpose connection (rate limiting); never put into subscriber mode */
  redis: Redis
  bus: EventBus
  settings: SettingsService
  logger: Logger
  /** absolute path to the built SPA; static serving is skipped when undefined */
  webDistDir?: string
}

export interface SessionAdmin {
  id: string
  login: string
}

export interface AuditOverrides {
  action?: string
  targetType?: string
  targetId?: string
  payload?: unknown
  /** for anonymous requests (login) once the actor is known */
  adminId?: string | null
}

export type AppEnv = {
  Variables: {
    deps: AppDeps
    clientIp: string
    admin: SessionAdmin | null
    sessionId: string | null
    audit: AuditOverrides
  }
}
```

`apps/api/src/lib/client-ip.ts`

```ts
import { getConnInfo } from '@hono/node-server/conninfo'
import type { Context } from 'hono'

/**
 * With TRUST_PROXY the first X-Forwarded-For hop is used (set by our reverse proxy);
 * otherwise the socket address — a client-supplied X-Forwarded-For is ignored.
 */
export function resolveClientIp(c: Context, trustProxy: boolean): string {
  if (trustProxy) {
    const forwarded = c.req.header('x-forwarded-for')?.split(',')[0]?.trim()
    if (forwarded) return forwarded
  }
  try {
    return getConnInfo(c).remote.address ?? 'unknown'
  } catch {
    return 'unknown'
  }
}
```

`apps/api/src/middleware/origin.ts`

```ts
import { createMiddleware } from 'hono/factory'
import type { AppEnv } from '../deps.ts'

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

/** CSRF guard: state-changing requests must come from PUBLIC_ORIGIN. */
export const originGuard = createMiddleware<AppEnv>(async (c, next) => {
  if (!SAFE_METHODS.has(c.req.method)) {
    const expected = new URL(c.get('deps').env.PUBLIC_ORIGIN).origin
    if (c.req.header('origin') !== expected) return c.json({ error: 'forbidden', message: 'Origin mismatch' }, 403)
  }
  await next()
})
```

`apps/api/src/routes/health.ts`

```ts
import { sql } from 'drizzle-orm'
import { Hono } from 'hono'
import type { AppEnv } from '../deps.ts'

export const healthRoutes = new Hono<AppEnv>().get('/healthz', async (c) => {
  const { db, redis } = c.get('deps')
  try {
    await db.execute(sql`select 1`)
    await redis.ping()
    return c.json({ ok: true })
  } catch {
    return c.json({ ok: false }, 503)
  }
})
```

`apps/api/src/routes/validation.ts`

```ts
import type { Context } from 'hono'

interface IssueLike {
  path: readonly PropertyKey[]
  message: string
}

/** zValidator hook: 400 { error: 'validation', fields: { 'a.b': message } }. */
export function validationHook(result: { success: boolean; error?: { issues: readonly IssueLike[] } }, c: Context) {
  if (result.success || !result.error) return undefined
  const fields: Record<string, string> = {}
  for (const issue of result.error.issues) {
    const path = issue.path.map(String).join('.') || '_'
    fields[path] ??= issue.message
  }
  return c.json({ error: 'validation', fields }, 400)
}
```

`apps/api/src/main.ts`

```ts
import { fileURLToPath } from 'node:url'
import { serve } from '@hono/node-server'
import { createDb } from '@workspace/db'
import { createEventBus, createLogger, createRedis, SettingsService } from '@workspace/server'
import { createCipher } from '@workspace/shared/crypto'
import { loadEnv } from '@workspace/shared/env'
import { createApp } from './app.ts'

const env = loadEnv()
const logger = createLogger({ level: env.LOG_LEVEL, pretty: env.NODE_ENV === 'development', name: 'api' })
const database = createDb(env.DATABASE_URL)
const redis = createRedis(env.REDIS_URL, 'api', logger)
const subscriber = createRedis(env.REDIS_URL, 'api-sub', logger)
const bus = await createEventBus({ publisher: redis, subscriber, logger })
const settings = await SettingsService.create({ db: database.db, cipher: createCipher(env.APP_ENCRYPTION_KEY), bus, logger })

const app = createApp({
  env,
  db: database.db,
  redis,
  bus,
  settings,
  logger,
  webDistDir: fileURLToPath(new URL('../../web/dist', import.meta.url)),
})

const server = serve({ fetch: app.fetch, port: env.PORT }, (info) => logger.info({ port: info.port }, 'api listening'))

let stopping = false
async function shutdown(signal: string): Promise<void> {
  if (stopping) return
  stopping = true
  logger.info({ signal }, 'api: shutting down')
  server.close()
  // open SSE streams would keep close() waiting forever
  if ('closeAllConnections' in server) server.closeAllConnections()
  settings.close()
  await bus.close()
  await Promise.allSettled([redis.quit(), subscriber.quit(), database.close()])
  process.exit(0)
}
process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))
```

`apps/api/src/app.ts`

```ts
import { existsSync } from 'node:fs'
import { serveStatic } from '@hono/node-server/serve-static'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import type { AppDeps, AppEnv } from './deps.ts'
import { resolveClientIp } from './lib/client-ip.ts'
import { originGuard } from './middleware/origin.ts'
import { healthRoutes } from './routes/health.ts'

export function createApp(deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  app.use('*', async (c, next) => {
    c.set('deps', deps)
    c.set('clientIp', resolveClientIp(c, deps.env.TRUST_PROXY))
    await next()
  })

  const api = new Hono<AppEnv>()
  api.use('*', originGuard)
  api.route('/', healthRoutes)
  api.all('*', (c) => c.json({ error: 'not_found' }, 404))
  app.route('/api', api)

  if (deps.webDistDir && existsSync(deps.webDistDir)) {
    app.use('/*', serveStatic({ root: deps.webDistDir }))
    app.get('*', serveStatic({ root: deps.webDistDir, path: 'index.html' })) // SPA fallback
  }

  app.onError((err, c) => {
    if (err instanceof HTTPException) return err.getResponse()
    deps.logger.error({ err, path: c.req.path }, 'unhandled error')
    return c.json({ error: 'internal', message: 'Внутренняя ошибка' }, 500)
  })

  return app
}
```

- [ ] **Шаг 5: Тесты**

```bash
npx vitest run --project api   # 2 passed
pnpm --filter api typecheck && pnpm --filter api lint
```

- [ ] **Шаг 6: Commit**

```bash
git add -A && git commit -m "feat(api): hono app shell, health check, origin guard, graceful shutdown"
```


---

### Задача 9: Вход админов: пароли, сессии, rate limit

**Files:**
- Create: `apps/api/src/lib/{password,sessions,rate-limit}.ts`, `apps/api/src/services/admins.ts`, `apps/api/src/middleware/auth.ts`, `apps/api/src/routes/auth.ts`
- Modify: `apps/api/src/app.ts`, `apps/api/test/helpers.ts`
- Test: `apps/api/test/auth.test.ts`

**Interfaces:**
- Produces: `hashPassword(pw)`, `verifyPassword(pw, stored)`; `SESSION_COOKIE`, `createSession`, `findSession`, `deleteSession`, `deleteAdminSessions`;
  `checkLimit`, `recordFailure`, `clearFailures`; `AdminError` (`login_taken|not_found|last_admin`), `toAdminDto`, `listAdmins`, `findAdminByLogin`, `createAdmin`, `setAdminPassword`, `disableAdmin`;
  `sessionLoader`, `requireAuth`; маршруты `POST /api/auth/login|logout|password`, `GET /api/auth/me`; тестовый `loginAs(ta)`.

- [ ] **Шаг 1: Дополнить хелперы и написать падающий тест**

Хелперы целиком (добавлены `uniqueLogin`, `sessionCookie`, `loginAs`):

`apps/api/test/helpers.ts`

```ts
import { randomBytes, randomUUID } from 'node:crypto'
import { createTestDatabase, type TestDatabase } from '@workspace/db/testing'
import { createEventBus, createLogger, createRedis, SettingsService, type EventBus, type Redis } from '@workspace/server'
import { createCipher } from '@workspace/shared/crypto'
import { loadEnv, type Env } from '@workspace/shared/env'
import { inject } from 'vitest'
import { createApp } from '../src/app.ts'
import type { AppDeps } from '../src/deps.ts'
import { createAdmin } from '../src/services/admins.ts'

export const ORIGIN = 'https://panel.test'

export interface TestApp {
  app: ReturnType<typeof createApp>
  deps: AppDeps
  t: TestDatabase
  bus: EventBus
  close(): Promise<void>
}

export async function setupApp(envOverrides: Record<string, string> = {}): Promise<TestApp> {
  const t = await createTestDatabase(inject('pgAdminUrl'))
  const redisUrl = inject('redisUrl')
  const redis: Redis = createRedis(redisUrl, 'test')
  const sub: Redis = createRedis(redisUrl, 'test-sub')
  const bus = await createEventBus({ publisher: redis, subscriber: sub, channel: `test:${randomUUID()}` })
  const env: Env = loadEnv({
    DATABASE_URL: t.url,
    REDIS_URL: redisUrl,
    APP_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    PUBLIC_ORIGIN: ORIGIN,
    NODE_ENV: 'test',
    ...envOverrides,
  })
  const settings = await SettingsService.create({ db: t.db, cipher: createCipher(env.APP_ENCRYPTION_KEY), bus })
  const deps: AppDeps = { env, db: t.db, redis, bus, settings, logger: createLogger({ level: 'silent' }) }
  return {
    app: createApp(deps),
    deps,
    t,
    bus,
    async close() {
      settings.close()
      await bus.close()
      await Promise.allSettled([redis.quit(), sub.quit()])
      await t.drop()
    },
  }
}

export interface RequestOptions {
  method?: string
  body?: unknown
  cookie?: string
  origin?: string | null
  ip?: string
  headers?: Record<string, string>
}

/** Sends a request through the Hono app with a fake Node socket (for getConnInfo). */
export async function send(app: TestApp['app'], path: string, o: RequestOptions = {}): Promise<Response> {
  const headers = new Headers(o.headers)
  if (o.origin !== null) headers.set('origin', o.origin ?? ORIGIN)
  if (o.cookie) headers.set('cookie', o.cookie)
  let body: RequestInit['body']
  if (o.body instanceof FormData) body = o.body
  else if (o.body !== undefined) {
    headers.set('content-type', 'application/json')
    body = JSON.stringify(o.body)
  }
  return await app.request(
    path,
    { method: o.method ?? (body ? 'POST' : 'GET'), headers, ...(body ? { body } : {}) },
    { incoming: { socket: { remoteAddress: o.ip ?? '10.0.0.1' } } },
  )
}

export function uniqueLogin(prefix = 'adm'): string {
  return `${prefix}${randomUUID().slice(0, 8)}`
}

export function sessionCookie(res: Response): string {
  const raw = res.headers.get('set-cookie') ?? ''
  const match = /accs_session=([^;]+)/.exec(raw)
  if (!match) throw new Error(`no session cookie in: ${raw}`)
  return `accs_session=${match[1]}`
}

/** Creates an admin and logs in; returns its id, login and cookie. */
export async function loginAs(ta: TestApp, password = 'correct horse battery'): Promise<{ id: string; login: string; cookie: string }> {
  const login = uniqueLogin()
  const admin = await createAdmin(ta.deps.db, { login, password })
  const res = await send(ta.app, '/api/auth/login', { body: { login, password }, ip: `10.9.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` })
  if (res.status !== 200) throw new Error(`login failed: ${res.status}`)
  return { id: admin.id, login, cookie: sessionCookie(res) }
}
```

`apps/api/test/auth.test.ts`

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createAdmin, disableAdmin } from '../src/services/admins.ts'
import { loginAs, send, sessionCookie, setupApp, uniqueLogin, type TestApp } from './helpers.ts'

let ta: TestApp
beforeAll(async () => {
  ta = await setupApp()
})
afterAll(async () => {
  await ta.close()
})

describe('auth', () => {
  it('logs in with a hardened session cookie and serves /me', async () => {
    const login = uniqueLogin()
    await createAdmin(ta.deps.db, { login, password: 'correct horse battery' })
    const res = await send(ta.app, '/api/auth/login', { body: { login: login.toUpperCase(), password: 'correct horse battery' } })
    expect(res.status).toBe(200)
    const setCookie = res.headers.get('set-cookie') ?? ''
    expect(setCookie).toMatch(/HttpOnly/)
    expect(setCookie).toMatch(/SameSite=Strict/)
    expect(setCookie).toMatch(/Secure/)
    const me = await send(ta.app, '/api/auth/me', { cookie: sessionCookie(res) })
    expect(await me.json()).toMatchObject({ login })
  })

  it('omits Secure for an http PUBLIC_ORIGIN (local dev in Safari)', async () => {
    const dev = await setupApp({ PUBLIC_ORIGIN: 'http://localhost:5173' })
    try {
      const login = uniqueLogin()
      await createAdmin(dev.deps.db, { login, password: 'correct horse battery' })
      const res = await send(dev.app, '/api/auth/login', { body: { login, password: 'correct horse battery' }, origin: 'http://localhost:5173' })
      expect(res.status).toBe(200)
      expect(res.headers.get('set-cookie')).not.toMatch(/Secure/)
    } finally {
      await dev.close()
    }
  })

  it('rejects wrong password, unknown and disabled admins with the same 401', async () => {
    const a = await loginAs(ta)
    const b = await loginAs(ta)
    await disableAdmin(ta.deps.db, b.id)
    for (const body of [
      { login: a.login, password: 'wrong password!' },
      { login: 'nobody-here', password: 'whatever12345' },
      { login: b.login, password: 'correct horse battery' },
    ]) {
      const res = await send(ta.app, '/api/auth/login', { body, ip: '10.1.1.1' })
      expect(res.status).toBe(401)
      expect(await res.json()).toMatchObject({ error: 'invalid_credentials' })
    }
  })

  it('rate-limits login attempts per login with Retry-After', async () => {
    await ta.deps.settings.update({ 'security.loginMaxAttempts': 3 }, { adminId: null })
    const login = uniqueLogin()
    const statuses: number[] = []
    for (let i = 0; i < 4; i++) {
      const res = await send(ta.app, '/api/auth/login', { body: { login, password: 'bad password!' }, ip: `10.2.0.${i}` })
      statuses.push(res.status)
      if (res.status === 429) expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0)
    }
    expect(statuses).toEqual([401, 401, 401, 429])
    await ta.deps.settings.update({ 'security.loginMaxAttempts': null }, { adminId: null })
  })

  it('never rate-limits successful logins', async () => {
    await ta.deps.settings.update({ 'security.loginMaxAttempts': 3 }, { adminId: null })
    const login = uniqueLogin()
    await createAdmin(ta.deps.db, { login, password: 'correct horse battery' })
    for (let i = 0; i < 6; i++) {
      const res = await send(ta.app, '/api/auth/login', { body: { login, password: 'correct horse battery' }, ip: '10.6.6.6' })
      expect(res.status).toBe(200)
    }
    await ta.deps.settings.update({ 'security.loginMaxAttempts': null }, { adminId: null })
  })

  it('logout invalidates the session', async () => {
    const { cookie } = await loginAs(ta)
    expect((await send(ta.app, '/api/auth/logout', { method: 'POST', cookie })).status).toBe(204)
    expect((await send(ta.app, '/api/auth/me', { cookie })).status).toBe(401)
  })

  it('changes password: checks the current one and revokes sessions', async () => {
    const { cookie } = await loginAs(ta)
    const bad = await send(ta.app, '/api/auth/password', { cookie, body: { currentPassword: 'nope', newPassword: 'another long secret' } })
    expect(bad.status).toBe(400)
    expect(await bad.json()).toMatchObject({ fields: { currentPassword: expect.any(String) } })
    const ok = await send(ta.app, '/api/auth/password', { cookie, body: { currentPassword: 'correct horse battery', newPassword: 'another long secret' } })
    expect(ok.status).toBe(204)
    expect((await send(ta.app, '/api/auth/me', { cookie })).status).toBe(401)
  })

  it('blocks state-changing requests without the expected Origin', async () => {
    const { cookie } = await loginAs(ta)
    expect((await send(ta.app, '/api/auth/logout', { method: 'POST', cookie, origin: null })).status).toBe(403)
    expect((await send(ta.app, '/api/auth/logout', { method: 'POST', cookie, origin: 'https://evil.test' })).status).toBe(403)
    expect((await send(ta.app, '/api/auth/me', { cookie, origin: null })).status).toBe(200)
  })
})
```

- [ ] **Шаг 2: Убедиться, что тест падает**

```bash
npx vitest run --project api -t auth
# FAIL: Cannot find module ../src/services/admins.ts
```

- [ ] **Шаг 3: Пароли, сессии, лимит попыток, сервис админов, маршруты входа**

- argon2id из `node:crypto` (без нативных модулей), строка в формате PHC; перед `timingSafeEqual` — проверка длины.
- Сессия: случайный токен в cookie, в БД только sha256; `Secure` — только если `PUBLIC_ORIGIN` на https (иначе Safari не сохранит cookie на `http://localhost`).
- Лимит считает **только неудачные** попытки (по IP и по логину); успешный вход никого не блокирует. Неизвестный логин тоже проходит одну проверку argon2 — время ответа не выдаёт существование логина.

`apps/api/src/lib/password.ts`

```ts
import { argon2, randomBytes, timingSafeEqual } from 'node:crypto'

// OWASP minimum for argon2id: m=19 MiB, t=2, p=1
const PARAMS = { memory: 19_456, passes: 2, parallelism: 1, tagLength: 32 }

function derive(password: string, nonce: Buffer, p: typeof PARAMS): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    argon2('argon2id', { message: password, nonce, ...p }, (err, key) => (err ? reject(err) : resolve(key)))
  })
}

/** Returns a PHC-style string: $argon2id$v=19$m=19456,t=2,p=1$<salt>$<hash> (base64, no padding). */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16)
  const hash = await derive(password, salt, PARAMS)
  const b64 = (b: Buffer) => b.toString('base64').replace(/=+$/, '')
  return `$argon2id$v=19$m=${PARAMS.memory},t=${PARAMS.passes},p=${PARAMS.parallelism}$${b64(salt)}$${b64(hash)}`
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const match = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$([^$]+)\$([^$]+)$/.exec(stored)
  if (!match) return false
  const [, m, t, p, salt, hash] = match as unknown as [string, string, string, string, string, string]
  const expected = Buffer.from(hash, 'base64')
  const actual = await derive(password, Buffer.from(salt, 'base64'), {
    memory: Number(m),
    passes: Number(t),
    parallelism: Number(p),
    tagLength: expected.length,
  })
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}
```

`apps/api/src/lib/sessions.ts`

```ts
import { createHash, randomBytes } from 'node:crypto'
import { admins, adminSessions, type Db } from '@workspace/db'
import { and, eq, gt, isNull } from 'drizzle-orm'
import type { SessionAdmin } from '../deps.ts'

export const SESSION_COOKIE = 'accs_session'

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex')

export async function createSession(
  db: Db,
  input: { adminId: string; ttlMs: number; ip: string; userAgent: string | null },
): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString('base64url')
  const expiresAt = new Date(Date.now() + input.ttlMs)
  await db.insert(adminSessions).values({
    tokenHash: hashToken(token),
    adminId: input.adminId,
    expiresAt,
    ip: input.ip,
    userAgent: input.userAgent,
  })
  return { token, expiresAt }
}

/** Valid = not expired and the admin is not disabled. */
export async function findSession(db: Db, token: string): Promise<{ sessionId: string; admin: SessionAdmin } | null> {
  const [row] = await db
    .select({ sessionId: adminSessions.id, id: admins.id, login: admins.login })
    .from(adminSessions)
    .innerJoin(admins, eq(admins.id, adminSessions.adminId))
    .where(and(eq(adminSessions.tokenHash, hashToken(token)), gt(adminSessions.expiresAt, new Date()), isNull(admins.disabledAt)))
    .limit(1)
  return row ? { sessionId: row.sessionId, admin: { id: row.id, login: row.login } } : null
}

export async function deleteSession(db: Db, sessionId: string): Promise<void> {
  await db.delete(adminSessions).where(eq(adminSessions.id, sessionId))
}

export async function deleteAdminSessions(db: Db, adminId: string): Promise<void> {
  await db.delete(adminSessions).where(eq(adminSessions.adminId, adminId))
}
```

`apps/api/src/lib/rate-limit.ts`

```ts
import type { Redis } from 'ioredis'

/**
 * Failed-attempt limiter: only failures are counted, so legitimate logins never lock anyone out.
 * Window starts at the first failure (PEXPIRE NX, Redis ≥ 7).
 */
export async function checkLimit(redis: Redis, key: string, limit: number): Promise<{ limited: boolean; retryAfterSec: number }> {
  const [[, count], [, ttl]] = (await redis.multi().get(key).pttl(key).exec()) as [[null, string | null], [null, number]]
  return { limited: Number(count ?? 0) >= limit, retryAfterSec: Math.max(1, Math.ceil(ttl / 1000)) }
}

export async function recordFailure(redis: Redis, key: string, windowMs: number): Promise<void> {
  await redis.multi().incr(key).pexpire(key, windowMs, 'NX').exec()
}

export async function clearFailures(redis: Redis, key: string): Promise<void> {
  await redis.del(key)
}
```

`apps/api/src/services/admins.ts`

```ts
import { admins, type Db } from '@workspace/db'
import type { AdminDto } from '@workspace/shared/api'
import { and, asc, count, eq, isNull, ne } from 'drizzle-orm'
import { hashPassword } from '../lib/password.ts'
import { deleteAdminSessions } from '../lib/sessions.ts'

export class AdminError extends Error {
  readonly code: 'login_taken' | 'not_found' | 'last_admin'
  constructor(code: AdminError['code']) {
    super(code)
    this.code = code
  }
}

type AdminRow = typeof admins.$inferSelect

export function toAdminDto(row: AdminRow): AdminDto {
  return {
    id: row.id,
    login: row.login,
    disabledAt: row.disabledAt?.toISOString() ?? null,
    lastLoginAt: row.lastLoginAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  }
}

export async function listAdmins(db: Db): Promise<AdminDto[]> {
  return (await db.select().from(admins).orderBy(asc(admins.createdAt))).map(toAdminDto)
}

export async function findAdminByLogin(db: Db, login: string): Promise<AdminRow | undefined> {
  const [row] = await db.select().from(admins).where(eq(admins.login, login)).limit(1)
  return row
}

export async function createAdmin(db: Db, input: { login: string; password: string }): Promise<AdminDto> {
  const passwordHash = await hashPassword(input.password)
  const [row] = await db.insert(admins).values({ login: input.login, passwordHash }).onConflictDoNothing().returning()
  if (!row) throw new AdminError('login_taken')
  return toAdminDto(row)
}

/** Revokes all sessions of the admin. */
export async function setAdminPassword(db: Db, adminId: string, password: string): Promise<void> {
  const passwordHash = await hashPassword(password)
  const [row] = await db.update(admins).set({ passwordHash }).where(eq(admins.id, adminId)).returning({ id: admins.id })
  if (!row) throw new AdminError('not_found')
  await deleteAdminSessions(db, adminId)
}

/** Refuses to disable the last active admin; revokes all sessions of the disabled one. */
export async function disableAdmin(db: Db, adminId: string): Promise<AdminDto> {
  return db.transaction(async (tx) => {
    const [target] = await tx.select().from(admins).where(eq(admins.id, adminId)).for('update')
    if (!target) throw new AdminError('not_found')
    if (target.disabledAt) return toAdminDto(target)
    const [others] = await tx
      .select({ n: count() })
      .from(admins)
      .where(and(isNull(admins.disabledAt), ne(admins.id, adminId)))
    if ((others?.n ?? 0) === 0) throw new AdminError('last_admin')
    const [row] = await tx.update(admins).set({ disabledAt: new Date() }).where(eq(admins.id, adminId)).returning()
    await deleteAdminSessions(tx as unknown as Db, adminId)
    return toAdminDto(row!)
  })
}
```

`apps/api/src/middleware/auth.ts`

```ts
import { getCookie } from 'hono/cookie'
import { createMiddleware } from 'hono/factory'
import type { AppEnv } from '../deps.ts'
import { findSession, SESSION_COOKIE } from '../lib/sessions.ts'

/** Resolves the session cookie into `admin`/`sessionId` (null when absent or invalid). */
export const sessionLoader = createMiddleware<AppEnv>(async (c, next) => {
  c.set('admin', null)
  c.set('sessionId', null)
  const token = getCookie(c, SESSION_COOKIE)
  if (token) {
    const found = await findSession(c.get('deps').db, token)
    if (found) {
      c.set('admin', found.admin)
      c.set('sessionId', found.sessionId)
    }
  }
  await next()
})

export const requireAuth = createMiddleware<AppEnv>(async (c, next) => {
  if (!c.get('admin')) return c.json({ error: 'unauthorized' }, 401)
  await next()
})
```

`apps/api/src/routes/auth.ts`

```ts
import { randomUUID } from 'node:crypto'
import { zValidator } from '@hono/zod-validator'
import { admins } from '@workspace/db'
import { changePasswordInput, loginInput, type MeResponse } from '@workspace/shared/api'
import { parseDuration } from '@workspace/shared/duration'
import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { deleteCookie, setCookie } from 'hono/cookie'
import type { AppEnv } from '../deps.ts'
import { hashPassword, verifyPassword } from '../lib/password.ts'
import { checkLimit, clearFailures, recordFailure } from '../lib/rate-limit.ts'
import { createSession, deleteSession, SESSION_COOKIE } from '../lib/sessions.ts'
import { requireAuth } from '../middleware/auth.ts'
import { validationHook } from './validation.ts'
import { findAdminByLogin, setAdminPassword } from '../services/admins.ts'

// Unknown logins still pay for one argon2 verification, so timing does not reveal which logins exist.
const DUMMY_HASH = await hashPassword(randomUUID())

export const authRoutes = new Hono<AppEnv>()
  .post('/auth/login', zValidator('json', loginInput, validationHook), async (c) => {
    const { db, redis, settings, env } = c.get('deps')
    const { login, password } = c.req.valid('json')
    c.set('audit', { action: 'auth.login', payload: { login } })

    const limit = settings.get('security.loginMaxAttempts')
    const windowMs = parseDuration(settings.get('security.loginWindow'))
    const ipKey = `rl:login:ip:${c.get('clientIp')}`
    const userKey = `rl:login:user:${login}`
    const [byIp, byUser] = await Promise.all([checkLimit(redis, ipKey, limit), checkLimit(redis, userKey, limit)])
    if (byIp.limited || byUser.limited) {
      c.header('Retry-After', String(Math.max(byIp.retryAfterSec, byUser.retryAfterSec)))
      return c.json({ error: 'rate_limited', message: 'Слишком много попыток входа' }, 429)
    }

    const admin = await findAdminByLogin(db, login)
    const ok = await verifyPassword(password, admin?.passwordHash ?? DUMMY_HASH)
    if (!admin || !ok || admin.disabledAt) {
      await Promise.all([recordFailure(redis, ipKey, windowMs), recordFailure(redis, userKey, windowMs)])
      return c.json({ error: 'invalid_credentials', message: 'Неверный логин или пароль' }, 401)
    }

    await clearFailures(redis, userKey)
    const ttlMs = parseDuration(settings.get('security.sessionTtl'))
    const session = await createSession(db, { adminId: admin.id, ttlMs, ip: c.get('clientIp'), userAgent: c.req.header('user-agent') ?? null })
    await db.update(admins).set({ lastLoginAt: new Date() }).where(eq(admins.id, admin.id))
    setCookie(c, SESSION_COOKIE, session.token, {
      httpOnly: true,
      sameSite: 'Strict',
      secure: env.PUBLIC_ORIGIN.startsWith('https://'),
      path: '/',
      expires: session.expiresAt,
    })
    c.set('audit', { action: 'auth.login', payload: { login }, adminId: admin.id })
    return c.json({ id: admin.id, login: admin.login } satisfies MeResponse)
  })
  .post('/auth/logout', async (c) => {
    c.set('audit', { action: 'auth.logout' })
    const sessionId = c.get('sessionId')
    if (sessionId) await deleteSession(c.get('deps').db, sessionId)
    deleteCookie(c, SESSION_COOKIE, { path: '/' })
    return c.body(null, 204)
  })
  .get('/auth/me', requireAuth, (c) => c.json(c.get('admin') satisfies MeResponse | null))
  .post('/auth/password', requireAuth, zValidator('json', changePasswordInput, validationHook), async (c) => {
    c.set('audit', { action: 'auth.password.change' })
    const { db } = c.get('deps')
    const me = c.get('admin')!
    const { currentPassword, newPassword } = c.req.valid('json')
    const row = await findAdminByLogin(db, me.login)
    if (!row || !(await verifyPassword(currentPassword, row.passwordHash))) {
      return c.json({ error: 'validation', fields: { currentPassword: 'Неверный текущий пароль' } }, 400)
    }
    await setAdminPassword(db, me.id, newPassword)
    deleteCookie(c, SESSION_COOKIE, { path: '/' })
    return c.body(null, 204)
  })
```

`apps/api/src/app.ts`

```ts
import { existsSync } from 'node:fs'
import { serveStatic } from '@hono/node-server/serve-static'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import type { AppDeps, AppEnv } from './deps.ts'
import { resolveClientIp } from './lib/client-ip.ts'
import { requireAuth, sessionLoader } from './middleware/auth.ts'
import { originGuard } from './middleware/origin.ts'
import { authRoutes } from './routes/auth.ts'
import { healthRoutes } from './routes/health.ts'

export function createApp(deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  app.use('*', async (c, next) => {
    c.set('deps', deps)
    c.set('clientIp', resolveClientIp(c, deps.env.TRUST_PROXY))
    await next()
  })

  const api = new Hono<AppEnv>()
  api.use('*', originGuard, sessionLoader)
  api.route('/', healthRoutes)
  api.route('/', authRoutes)
  api.use('*', requireAuth)
  api.all('*', (c) => c.json({ error: 'not_found' }, 404))
  app.route('/api', api)

  if (deps.webDistDir && existsSync(deps.webDistDir)) {
    app.use('/*', serveStatic({ root: deps.webDistDir }))
    app.get('*', serveStatic({ root: deps.webDistDir, path: 'index.html' })) // SPA fallback
  }

  app.onError((err, c) => {
    if (err instanceof HTTPException) return err.getResponse()
    deps.logger.error({ err, path: c.req.path }, 'unhandled error')
    return c.json({ error: 'internal', message: 'Внутренняя ошибка' }, 500)
  })

  return app
}
```

- [ ] **Шаг 4: Тесты**

```bash
npx vitest run --project api   # 10 passed
pnpm --filter api typecheck && pnpm --filter api lint
```

- [ ] **Шаг 5: Commit**

```bash
git add -A && git commit -m "feat(api): admin auth — argon2id, cookie sessions, failed-attempt rate limit"
```


---

### Задача 10: Глобальный аудит и `GET /api/audit`

**Files:**
- Create: `apps/api/src/middleware/audit.ts`, `apps/api/src/routes/audit.ts`
- Modify: `apps/api/src/app.ts`
- Test: `apps/api/test/audit.test.ts`

**Interfaces:**
- Consumes: `writeAudit`, `AuditActor` (7), `AuditOverrides` (8).
- Produces: `auditTrail` (глобальный middleware), `audited(action, { target?: [type, param]; payload?: null })`; `GET /api/audit?page&pageSize&adminId&action&from&to` → `AuditPage`.

- [ ] **Шаг 1: Написать падающий тест**

`apps/api/test/audit.test.ts`

```ts
import { auditLog } from '@workspace/db'
import { desc, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { AppEnv } from '../src/deps.ts'
import { auditTrail } from '../src/middleware/audit.ts'
import { createAdmin } from '../src/services/admins.ts'
import { loginAs, send, setupApp, uniqueLogin, type TestApp } from './helpers.ts'

let ta: TestApp
beforeAll(async () => {
  ta = await setupApp()
})
afterAll(async () => {
  await ta.close()
})

const lastAudit = async () => (await ta.t.db.select().from(auditLog).orderBy(desc(auditLog.id)).limit(1))[0]

/** A tiny app that uses the real auditTrail middleware with routes that misbehave. */
function probeApp() {
  const app = new Hono<AppEnv>()
  app.use('*', async (c, next) => {
    c.set('deps', ta.deps)
    c.set('clientIp', '10.5.5.5')
    c.set('admin', null)
    c.set('sessionId', null)
    await next()
  })
  app.use('*', auditTrail)
  app.post('/boom', () => {
    throw new Error('kaboom')
  })
  app.post('/echo', (c) => c.json({ ok: true }))
  app.onError((_err, c) => c.json({ error: 'internal' }, 500))
  return app
}

describe('audit trail', () => {
  it('records successful and failed logins without the password', async () => {
    const { id, login } = await loginAs(ta)
    let row = (await ta.t.db.select().from(auditLog).where(eq(auditLog.adminId, id)).orderBy(desc(auditLog.id)).limit(1))[0]
    expect(row).toMatchObject({ action: 'auth.login', actorType: 'admin', result: 'ok', statusCode: 200, payload: { login } })

    await send(ta.app, '/api/auth/login', { body: { login: 'ghost', password: 'secret-pass-123' }, ip: '10.4.4.4' })
    row = await lastAudit()
    expect(row).toMatchObject({ action: 'auth.login', adminId: null, result: 'error', statusCode: 401, payload: { login: 'ghost' } })
    expect(JSON.stringify(row?.payload)).not.toContain('secret-pass-123')
  })

  it('still records a request whose handler threw', async () => {
    await probeApp().request('/boom', { method: 'POST' })
    expect(await lastAudit()).toMatchObject({ action: 'POST /boom', result: 'error', statusCode: 500 })
  })

  it('redacts uploaded files and secret fields in multipart bodies', async () => {
    const form = new FormData()
    form.set('note', 'hello')
    form.set('passcode', '1234')
    form.set('archive', new File(['zip-bytes'], 'tdata.zip'))
    await probeApp().request('/echo', { method: 'POST', body: form })
    expect((await lastAudit())?.payload).toEqual({ note: 'hello', passcode: '[redacted]', archive: '[redacted:file]' })
  })

  it('truncates oversized payloads', async () => {
    await probeApp().request('/echo', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ items: Array.from({ length: 500 }, (_, i) => `item-${i}-${'x'.repeat(40)}`) }),
    })
    expect((await lastAudit())?.payload).toMatchObject({ truncated: true, preview: expect.any(String) })
  })

  it('lists entries with admin login and filters by action', async () => {
    const leaving = await loginAs(ta)
    const reader = await loginAs(ta)
    await send(ta.app, '/api/auth/logout', { method: 'POST', cookie: leaving.cookie })
    const res = await send(ta.app, '/api/audit?action=auth.logout&pageSize=10', { cookie: reader.cookie })
    expect(res.status).toBe(200)
    const page = (await res.json()) as { items: { action: string; adminLogin: string | null }[]; total: number }
    expect(page.total).toBeGreaterThanOrEqual(1)
    expect(page.items.every((i) => i.action === 'auth.logout')).toBe(true)
    expect(page.items.map((i) => i.adminLogin)).toContain(leaving.login)
  })

  it('uses the socket address unless TRUST_PROXY is on', async () => {
    const login = uniqueLogin()
    await createAdmin(ta.deps.db, { login, password: 'correct horse battery' })
    await send(ta.app, '/api/auth/login', { body: { login, password: 'x-wrong-x' }, ip: '10.3.3.3', headers: { 'x-forwarded-for': '6.6.6.6' } })
    const [row] = await ta.t.db.select().from(auditLog).where(eq(auditLog.action, 'auth.login')).orderBy(desc(auditLog.id)).limit(1)
    expect(row?.ip).toBe('10.3.3.3')

    const proxied = await setupApp({ TRUST_PROXY: 'true' })
    try {
      await send(proxied.app, '/api/auth/login', { body: { login, password: 'x-wrong-x' }, ip: '10.3.3.3', headers: { 'x-forwarded-for': '7.7.7.7, 10.0.0.2' } })
      const [r2] = await proxied.t.db.select().from(auditLog).orderBy(desc(auditLog.id)).limit(1)
      expect(r2?.ip).toBe('7.7.7.7')
    } finally {
      await proxied.close()
    }
  })

  it('requires auth for the audit list', async () => {
    expect((await send(ta.app, '/api/audit')).status).toBe(401)
  })
})
```

- [ ] **Шаг 2: Убедиться, что тест падает**

```bash
npx vitest run --project api -t "audit trail"
# FAIL: Cannot find module ../src/middleware/audit.ts
```

- [ ] **Шаг 3: Middleware аудита и список**

- Пишется каждый `POST/PUT/PATCH/DELETE` и любой маршрут с `audited()` (чувствительные чтения). Запись создаётся и если обработчик бросил исключение (Hono превращает его в ответ `onError` до выхода из `next()`).
- `action` — из `audited()`/`c.set('audit')`, иначе `METHOD /route/:pattern` (`routePath(c)` из `hono/route`).
- Тело: JSON или multipart (файлы → `[redacted:file]`), больше 16 КБ → `{ truncated, preview }`. `audited(..., { payload: null })` — сырое тело не читается вообще.

`apps/api/src/middleware/audit.ts`

```ts
import { writeAudit, type AuditActor } from '@workspace/server'
import type { Context } from 'hono'
import { createMiddleware } from 'hono/factory'
import { routePath } from 'hono/route'
import type { AppEnv, AuditOverrides } from '../deps.ts'

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])
const MAX_PAYLOAD_CHARS = 16_384

/**
 * Per-route audit metadata. Also marks a GET as sensitive (audited).
 * Usage: app.get('/accounts/:id/sessions', audited('account.sessions.read', { target: ['account', 'id'] }), handler)
 * Handlers may refine it later: c.set('audit', { ...c.get('audit'), targetId })
 */
export function audited(action: string, options: { target?: [type: string, param: string]; payload?: null } = {}) {
  return createMiddleware<AppEnv>(async (c, next) => {
    const overrides: AuditOverrides = { ...c.get('audit'), action }
    // payload: null — never read the raw body (it may carry secrets); the handler sets a safe payload
    if (options.payload === null) overrides.payload = null
    if (options.target) {
      overrides.targetType = options.target[0]
      const id = c.req.param(options.target[1])
      if (id !== undefined) overrides.targetId = id
    }
    c.set('audit', overrides)
    await next()
  })
}

async function readBody(c: Context<AppEnv>): Promise<unknown> {
  const type = c.req.header('content-type') ?? ''
  try {
    if (type.includes('application/json')) return await c.req.json()
    if (type.includes('multipart/form-data') || type.includes('application/x-www-form-urlencoded')) return await c.req.parseBody({ all: true })
  } catch {
    return '[unparseable body]'
  }
  return null
}

function capPayload(payload: unknown): unknown {
  const text = JSON.stringify(payload) ?? 'null'
  return text.length > MAX_PAYLOAD_CHARS ? { truncated: true, preview: text.slice(0, 2_000) } : payload
}

/** Writes one audit_log row for every mutating request and every route marked with audited(). */
export const auditTrail = createMiddleware<AppEnv>(async (c, next) => {
  c.set('audit', {})
  const startedAt = performance.now()
  await next()

  const overrides = c.get('audit')
  if (!MUTATING.has(c.req.method) && overrides.action === undefined) return

  const actor: AuditActor = { type: 'admin', adminId: c.get('admin')?.id ?? overrides.adminId ?? null }
  const payload = overrides.payload !== undefined ? overrides.payload : await readBody(c)
  const { db, logger } = c.get('deps')
  try {
    await writeAudit(db, {
      actor,
      action: overrides.action ?? `${c.req.method} ${routePath(c)}`,
      targetType: overrides.targetType ?? null,
      targetId: overrides.targetId ?? null,
      payload: capPayload(payload),
      ip: c.get('clientIp'),
      userAgent: c.req.header('user-agent') ?? null,
      statusCode: c.res.status,
      result: c.res.status < 400 ? 'ok' : 'error',
      durationMs: Math.round(performance.now() - startedAt),
    })
  } catch (err) {
    logger.error({ err }, 'audit: failed to write record')
  }
})
```

`apps/api/src/routes/audit.ts`

```ts
import { zValidator } from '@hono/zod-validator'
import { admins, auditLog } from '@workspace/db'
import { auditQuery, type AuditPage } from '@workspace/shared/api'
import { and, count, desc, eq, gte, lte, type SQL } from 'drizzle-orm'
import { Hono } from 'hono'
import type { AppEnv } from '../deps.ts'
import { validationHook } from './validation.ts'

export const auditRoutes = new Hono<AppEnv>().get('/audit', zValidator('query', auditQuery, validationHook), async (c) => {
  const { db } = c.get('deps')
  const q = c.req.valid('query')
  const filters: SQL[] = []
  if (q.adminId) filters.push(eq(auditLog.adminId, q.adminId))
  if (q.action) filters.push(eq(auditLog.action, q.action))
  if (q.from) filters.push(gte(auditLog.createdAt, new Date(q.from)))
  if (q.to) filters.push(lte(auditLog.createdAt, new Date(q.to)))
  const where = filters.length > 0 ? and(...filters) : undefined

  const [rows, [total]] = await Promise.all([
    db
      .select({ entry: auditLog, adminLogin: admins.login })
      .from(auditLog)
      .leftJoin(admins, eq(admins.id, auditLog.adminId))
      .where(where)
      .orderBy(desc(auditLog.id))
      .limit(q.pageSize)
      .offset((q.page - 1) * q.pageSize),
    db.select({ n: count() }).from(auditLog).where(where),
  ])

  return c.json({
    items: rows.map(({ entry, adminLogin }) => ({
      id: String(entry.id),
      actorType: entry.actorType,
      adminId: entry.adminId,
      adminLogin,
      action: entry.action,
      targetType: entry.targetType,
      targetId: entry.targetId,
      payload: entry.payload,
      ip: entry.ip,
      userAgent: entry.userAgent,
      statusCode: entry.statusCode,
      result: entry.result,
      durationMs: entry.durationMs,
      createdAt: entry.createdAt.toISOString(),
    })),
    total: total?.n ?? 0,
    page: q.page,
    pageSize: q.pageSize,
  } satisfies AuditPage)
})
```

`apps/api/src/app.ts`

```ts
import { existsSync } from 'node:fs'
import { serveStatic } from '@hono/node-server/serve-static'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import type { AppDeps, AppEnv } from './deps.ts'
import { resolveClientIp } from './lib/client-ip.ts'
import { auditTrail } from './middleware/audit.ts'
import { requireAuth, sessionLoader } from './middleware/auth.ts'
import { originGuard } from './middleware/origin.ts'
import { auditRoutes } from './routes/audit.ts'
import { authRoutes } from './routes/auth.ts'
import { healthRoutes } from './routes/health.ts'

export function createApp(deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  app.use('*', async (c, next) => {
    c.set('deps', deps)
    c.set('clientIp', resolveClientIp(c, deps.env.TRUST_PROXY))
    await next()
  })

  const api = new Hono<AppEnv>()
  api.use('*', originGuard, sessionLoader, auditTrail)
  api.route('/', healthRoutes)
  api.route('/', authRoutes)
  api.use('*', requireAuth)
  api.route('/', auditRoutes)
  api.all('*', (c) => c.json({ error: 'not_found' }, 404))
  app.route('/api', api)

  if (deps.webDistDir && existsSync(deps.webDistDir)) {
    app.use('/*', serveStatic({ root: deps.webDistDir }))
    app.get('*', serveStatic({ root: deps.webDistDir, path: 'index.html' })) // SPA fallback
  }

  app.onError((err, c) => {
    if (err instanceof HTTPException) return err.getResponse()
    deps.logger.error({ err, path: c.req.path }, 'unhandled error')
    return c.json({ error: 'internal', message: 'Внутренняя ошибка' }, 500)
  })

  return app
}
```

- [ ] **Шаг 4: Тесты**

```bash
npx vitest run --project api   # 17 passed
pnpm --filter api typecheck && pnpm --filter api lint
```

- [ ] **Шаг 5: Commit**

```bash
git add -A && git commit -m "feat(api): global audit trail middleware and audit log endpoint"
```


---

### Задача 11: Управление админами

**Files:**
- Create: `apps/api/src/routes/admins.ts`
- Modify: `apps/api/src/app.ts`
- Test: `apps/api/test/admins.test.ts`

**Interfaces:**
- Produces: `GET /api/admins` → `{ items: AdminDto[] }`; `POST /api/admins` (201); `POST /api/admins/:id/disable`; `POST /api/admins/:id/reset-password` (204).
  Ошибки: 409 `login_taken`, 409 `last_admin`, 404 `not_found`, 400 `validation`.

- [ ] **Шаг 1: Написать падающий тест**

`apps/api/test/admins.test.ts`

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { loginAs, send, setupApp, uniqueLogin, type TestApp } from './helpers.ts'

let ta: TestApp
beforeAll(async () => {
  ta = await setupApp()
})
afterAll(async () => {
  await ta.close()
})

describe('admins', () => {
  it('creates, lists and rejects duplicates and bad input', async () => {
    const { cookie } = await loginAs(ta)
    const login = uniqueLogin()
    const created = await send(ta.app, '/api/admins', { cookie, body: { login, password: 'long enough password' } })
    expect(created.status).toBe(201)
    expect(await created.json()).not.toHaveProperty('passwordHash')
    expect((await send(ta.app, '/api/admins', { cookie, body: { login, password: 'long enough password' } })).status).toBe(409)
    const bad = await send(ta.app, '/api/admins', { cookie, body: { login: 'A B', password: 'short' } })
    expect(bad.status).toBe(400)
    expect(Object.keys(((await bad.json()) as { fields: object }).fields).sort()).toEqual(['login', 'password'])
    const list = (await (await send(ta.app, '/api/admins', { cookie })).json()) as { items: { login: string }[] }
    expect(list.items.map((a) => a.login)).toContain(login)
  })

  it('disabling an admin revokes their live sessions', async () => {
    const me = await loginAs(ta)
    const other = await loginAs(ta)
    expect((await send(ta.app, '/api/auth/me', { cookie: other.cookie })).status).toBe(200)
    const res = await send(ta.app, `/api/admins/${other.id}/disable`, { method: 'POST', cookie: me.cookie })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ disabledAt: expect.any(String) })
    expect((await send(ta.app, '/api/auth/me', { cookie: other.cookie })).status).toBe(401)
  })

  it('refuses to disable the last active admin', async () => {
    const solo = await setupApp()
    try {
      const me = await loginAs(solo)
      const res = await send(solo.app, `/api/admins/${me.id}/disable`, { method: 'POST', cookie: me.cookie })
      expect(res.status).toBe(409)
      expect(await res.json()).toMatchObject({ error: 'last_admin' })
    } finally {
      await solo.close()
    }
  })

  it('reset-password revokes the target sessions', async () => {
    const me = await loginAs(ta)
    const other = await loginAs(ta)
    const res = await send(ta.app, `/api/admins/${other.id}/reset-password`, { cookie: me.cookie, body: { password: 'brand new password' } })
    expect(res.status).toBe(204)
    expect((await send(ta.app, '/api/auth/me', { cookie: other.cookie })).status).toBe(401)
  })

  it('returns 404 for unknown and 400 for malformed ids', async () => {
    const { cookie } = await loginAs(ta)
    expect((await send(ta.app, '/api/admins/00000000-0000-4000-8000-000000000000/disable', { method: 'POST', cookie })).status).toBe(404)
    expect((await send(ta.app, '/api/admins/not-a-uuid/disable', { method: 'POST', cookie })).status).toBe(400)
  })
})
```

- [ ] **Шаг 2: Убедиться, что тест падает**

```bash
npx vitest run --project api -t admins
# FAIL: 404 вместо 201 (маршрутов ещё нет)
```

- [ ] **Шаг 3: Маршруты админов и маппинг доменных ошибок**

Доменные ошибки (`AdminError`) обрабатываются в одном глобальном `app.onError` — без `onError` во вложенных приложениях.

`apps/api/src/routes/admins.ts`

```ts
import { zValidator } from '@hono/zod-validator'
import { createAdminInput, resetPasswordInput } from '@workspace/shared/api'
import { Hono } from 'hono'
import { z } from 'zod'
import type { AppEnv } from '../deps.ts'
import { audited } from '../middleware/audit.ts'
import { createAdmin, disableAdmin, listAdmins, setAdminPassword } from '../services/admins.ts'
import { validationHook } from './validation.ts'

const idParam = z.object({ id: z.uuid() })

export const adminRoutes = new Hono<AppEnv>()
  .get('/admins', async (c) => c.json({ items: await listAdmins(c.get('deps').db) }))
  .post('/admins', audited('admin.create'), zValidator('json', createAdminInput, validationHook), async (c) => {
    const admin = await createAdmin(c.get('deps').db, c.req.valid('json'))
    c.set('audit', { ...c.get('audit'), targetType: 'admin', targetId: admin.id })
    return c.json(admin, 201)
  })
  .post('/admins/:id/disable', audited('admin.disable', { target: ['admin', 'id'] }), zValidator('param', idParam, validationHook), async (c) =>
    c.json(await disableAdmin(c.get('deps').db, c.req.valid('param').id)),
  )
  .post(
    '/admins/:id/reset-password',
    audited('admin.password.reset', { target: ['admin', 'id'] }),
    zValidator('param', idParam, validationHook),
    zValidator('json', resetPasswordInput, validationHook),
    async (c) => {
      await setAdminPassword(c.get('deps').db, c.req.valid('param').id, c.req.valid('json').password)
      return c.body(null, 204)
    },
  )
```

`apps/api/src/app.ts`

```ts
import { existsSync } from 'node:fs'
import { serveStatic } from '@hono/node-server/serve-static'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import type { AppDeps, AppEnv } from './deps.ts'
import { resolveClientIp } from './lib/client-ip.ts'
import { auditTrail } from './middleware/audit.ts'
import { requireAuth, sessionLoader } from './middleware/auth.ts'
import { originGuard } from './middleware/origin.ts'
import { adminRoutes } from './routes/admins.ts'
import { auditRoutes } from './routes/audit.ts'
import { authRoutes } from './routes/auth.ts'
import { healthRoutes } from './routes/health.ts'
import { AdminError } from './services/admins.ts'

const ADMIN_ERRORS = {
  login_taken: [409, 'Логин уже занят'],
  not_found: [404, 'Админ не найден'],
  last_admin: [409, 'Нельзя отключить последнего активного админа'],
} as const

export function createApp(deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  app.use('*', async (c, next) => {
    c.set('deps', deps)
    c.set('clientIp', resolveClientIp(c, deps.env.TRUST_PROXY))
    await next()
  })

  const api = new Hono<AppEnv>()
  api.use('*', originGuard, sessionLoader, auditTrail)
  api.route('/', healthRoutes)
  api.route('/', authRoutes)
  api.use('*', requireAuth)
  api.route('/', adminRoutes)
  api.route('/', auditRoutes)
  api.all('*', (c) => c.json({ error: 'not_found' }, 404))
  app.route('/api', api)

  if (deps.webDistDir && existsSync(deps.webDistDir)) {
    app.use('/*', serveStatic({ root: deps.webDistDir }))
    app.get('*', serveStatic({ root: deps.webDistDir, path: 'index.html' })) // SPA fallback
  }

  app.onError((err, c) => {
    if (err instanceof AdminError) {
      const [status, message] = ADMIN_ERRORS[err.code]
      return c.json({ error: err.code, message }, status)
    }
    if (err instanceof HTTPException) return err.getResponse()
    deps.logger.error({ err, path: c.req.path }, 'unhandled error')
    return c.json({ error: 'internal', message: 'Внутренняя ошибка' }, 500)
  })

  return app
}
```

- [ ] **Шаг 4: Тесты**

```bash
npx vitest run --project api   # 22 passed
pnpm --filter api typecheck && pnpm --filter api lint
```

- [ ] **Шаг 5: Commit**

```bash
git add -A && git commit -m "feat(api): admins management (create, disable, reset password)"
```


---

### Задача 12: API настроек и поток событий SSE

**Files:**
- Create: `apps/api/src/routes/{settings,events}.ts`
- Modify: `apps/api/src/app.ts`
- Test: `apps/api/test/{settings,events}.test.ts`

**Interfaces:**
- Produces: `GET /api/settings` → `SettingsResponse` (секреты — только `isSet`); `PATCH /api/settings` `{ changes: { key: value | null } }` → `SettingsResponse` | 400 `{ fields }`;
  `GET /api/events` (SSE: `ready`, `ping`, `settings.changed`).

- [ ] **Шаг 1: Написать падающие тесты**

`apps/api/test/settings.test.ts`

```ts
import { auditLog } from '@workspace/db'
import type { AppEvent } from '@workspace/shared/events'
import { desc, eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { loginAs, send, setupApp, type TestApp } from './helpers.ts'

let ta: TestApp
let cookie: string
let adminId: string
beforeAll(async () => {
  ta = await setupApp()
  ;({ cookie, id: adminId } = await loginAs(ta))
})
afterAll(async () => {
  await ta.close()
})

type Items = Record<string, { value: unknown; isSet: boolean; overridden: boolean; updatedBy: string | null }>

describe('settings API', () => {
  it('returns every setting with defaults and hides secret values', async () => {
    const { items } = (await (await send(ta.app, '/api/settings', { cookie })).json()) as { items: Items }
    expect(items['worker.connectConcurrency']).toMatchObject({ value: 5, overridden: false })
    expect(items['notify.botToken']).toMatchObject({ value: null, isSet: false })
  })

  it('updates values, broadcasts settings.changed and audits a redacted diff', async () => {
    const events: AppEvent[] = []
    const off = ta.bus.subscribe((e) => events.push(e))
    const res = await send(ta.app, '/api/settings', {
      method: 'PATCH',
      cookie,
      body: { changes: { 'worker.connectConcurrency': 8, 'notify.botToken': '42:TOKEN' } },
    })
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).not.toContain('42:TOKEN')
    const { items } = JSON.parse(text) as { items: Items }
    expect(items['worker.connectConcurrency']).toMatchObject({ value: 8, overridden: true, updatedBy: adminId })
    expect(items['notify.botToken']).toMatchObject({ value: null, isSet: true })
    await vi.waitFor(() => expect(events).toContainEqual({ type: 'settings.changed', keys: ['worker.connectConcurrency', 'notify.botToken'], by: adminId }))
    off()

    const [row] = await ta.t.db.select().from(auditLog).where(eq(auditLog.action, 'settings.update')).orderBy(desc(auditLog.id)).limit(1)
    expect(JSON.stringify(row?.payload)).not.toContain('42:TOKEN')
    expect(row?.payload).toEqual({
      diff: [
        { key: 'worker.connectConcurrency', from: 5, to: 8 },
        { key: 'notify.botToken', from: '[redacted]', to: '[redacted]' },
      ],
    })
  })

  it('rejects an empty secret, unknown keys and bad values without applying anything', async () => {
    const res = await send(ta.app, '/api/settings', {
      method: 'PATCH',
      cookie,
      body: { changes: { 'proxyStore.apiKey': '', 'no.such.key': 1, 'proxy.failThreshold': 4 } },
    })
    expect(res.status).toBe(400)
    const { fields } = (await res.json()) as { fields: Record<string, string> }
    expect(fields['proxyStore.apiKey']).toMatch(/Очистить/)
    expect(fields['no.such.key']).toBeDefined()
    expect(ta.deps.settings.get('proxy.failThreshold')).toBe(3)
  })

  it('null clears a secret', async () => {
    await send(ta.app, '/api/settings', { method: 'PATCH', cookie, body: { changes: { 'notify.botToken': 'x:y' } } })
    const res = await send(ta.app, '/api/settings', { method: 'PATCH', cookie, body: { changes: { 'notify.botToken': null } } })
    const { items } = (await res.json()) as { items: Items }
    expect(items['notify.botToken']).toMatchObject({ isSet: false, overridden: false })
  })

  it('requires auth', async () => {
    expect((await send(ta.app, '/api/settings')).status).toBe(401)
  })
})
```

`apps/api/test/events.test.ts`

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { loginAs, send, setupApp, type TestApp } from './helpers.ts'

let ta: TestApp
beforeAll(async () => {
  ta = await setupApp()
})
afterAll(async () => {
  await ta.close()
})

async function readUntil(reader: ReadableStreamDefaultReader<Uint8Array>, needle: string): Promise<string> {
  const decoder = new TextDecoder()
  let text = ''
  while (!text.includes(needle)) {
    const { value, done } = await reader.read()
    if (done) break
    text += decoder.decode(value, { stream: true })
  }
  return text
}

describe('SSE /api/events', () => {
  it('streams bus events to an authenticated client', async () => {
    const { cookie } = await loginAs(ta)
    const res = await send(ta.app, '/api/events', { cookie })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/text\/event-stream/)
    expect(res.headers.get('x-accel-buffering')).toBe('no')
    const reader = res.body!.getReader()
    expect(await readUntil(reader, 'event: ready')).toContain('event: ready')
    await ta.bus.publish({ type: 'settings.changed', keys: ['notify.enabled'], by: null })
    const text = await readUntil(reader, 'settings.changed')
    expect(text).toContain('event: settings.changed')
    expect(text).toContain('"keys":["notify.enabled"]')
    await reader.cancel()
  })

  it('rejects anonymous clients', async () => {
    expect((await send(ta.app, '/api/events')).status).toBe(401)
  })
})
```

- [ ] **Шаг 2: Убедиться, что тесты падают**

```bash
npx vitest run --project api -t "settings API|SSE"
# FAIL: 404
```

- [ ] **Шаг 3: Маршруты настроек и SSE**

- `PATCH /settings`: сырое тело с секретами в аудит не попадает — туда пишутся ключи, а после успеха redacted-diff.
- SSE: `X-Accel-Buffering: no` (nginx), событие `ready` сразу, `ping` каждые 25 с; каждое соединение подписывается на шину процесса.

`apps/api/src/routes/settings.ts`

```ts
import { zValidator } from '@hono/zod-validator'
import { settingsPatchInput, type SettingsResponse } from '@workspace/shared/api'
import { Hono } from 'hono'
import type { AppEnv } from '../deps.ts'
import { audited } from '../middleware/audit.ts'
import { validationHook } from './validation.ts'

export const settingsRoutes = new Hono<AppEnv>()
  .get('/settings', (c) => c.json({ items: c.get('deps').settings.snapshot() } satisfies SettingsResponse))
  // the raw body may carry secret values — audit records keys / the redacted diff instead
  .patch('/settings', audited('settings.update', { payload: null }), zValidator('json', settingsPatchInput, validationHook), async (c) => {
    const { settings } = c.get('deps')
    const { changes } = c.req.valid('json')
    c.set('audit', { ...c.get('audit'), payload: { keys: Object.keys(changes) } })
    const result = await settings.update(changes, { adminId: c.get('admin')!.id })
    if (!result.ok) return c.json({ error: 'validation', fields: result.errors }, 400)
    c.set('audit', { ...c.get('audit'), payload: { diff: result.diff } })
    return c.json({ items: settings.snapshot() } satisfies SettingsResponse)
  })
```

`apps/api/src/routes/events.ts`

```ts
import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import type { AppEnv } from '../deps.ts'

const HEARTBEAT_MS = 25_000

/** Live events for the SPA. Each connection subscribes to the in-process bus fan-out. */
export const eventRoutes = new Hono<AppEnv>().get('/events', (c) => {
  c.header('X-Accel-Buffering', 'no')
  c.header('Cache-Control', 'no-cache')
  const { bus } = c.get('deps')
  return streamSSE(c, async (stream) => {
    let open = true
    const unsubscribe = bus.subscribe((event) => {
      void stream.writeSSE({ event: event.type, data: JSON.stringify(event) })
    })
    stream.onAbort(() => {
      open = false
      unsubscribe()
    })
    await stream.writeSSE({ event: 'ready', data: '{}' })
    while (open) {
      await stream.sleep(HEARTBEAT_MS)
      if (open) await stream.writeSSE({ event: 'ping', data: '{}' })
    }
  })
})
```

`apps/api/src/app.ts`

```ts
import { existsSync } from 'node:fs'
import { serveStatic } from '@hono/node-server/serve-static'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import type { AppDeps, AppEnv } from './deps.ts'
import { resolveClientIp } from './lib/client-ip.ts'
import { auditTrail } from './middleware/audit.ts'
import { requireAuth, sessionLoader } from './middleware/auth.ts'
import { originGuard } from './middleware/origin.ts'
import { adminRoutes } from './routes/admins.ts'
import { auditRoutes } from './routes/audit.ts'
import { authRoutes } from './routes/auth.ts'
import { eventRoutes } from './routes/events.ts'
import { healthRoutes } from './routes/health.ts'
import { settingsRoutes } from './routes/settings.ts'
import { AdminError } from './services/admins.ts'

const ADMIN_ERRORS = {
  login_taken: [409, 'Логин уже занят'],
  not_found: [404, 'Админ не найден'],
  last_admin: [409, 'Нельзя отключить последнего активного админа'],
} as const

export function createApp(deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  app.use('*', async (c, next) => {
    c.set('deps', deps)
    c.set('clientIp', resolveClientIp(c, deps.env.TRUST_PROXY))
    await next()
  })

  const api = new Hono<AppEnv>()
  api.use('*', originGuard, sessionLoader, auditTrail)
  api.route('/', healthRoutes)
  api.route('/', authRoutes)
  api.use('*', requireAuth)
  api.route('/', adminRoutes)
  api.route('/', settingsRoutes)
  api.route('/', auditRoutes)
  api.route('/', eventRoutes)
  api.all('*', (c) => c.json({ error: 'not_found' }, 404))
  app.route('/api', api)

  if (deps.webDistDir && existsSync(deps.webDistDir)) {
    app.use('/*', serveStatic({ root: deps.webDistDir }))
    app.get('*', serveStatic({ root: deps.webDistDir, path: 'index.html' })) // SPA fallback
  }

  app.onError((err, c) => {
    if (err instanceof AdminError) {
      const [status, message] = ADMIN_ERRORS[err.code]
      return c.json({ error: err.code, message }, status)
    }
    if (err instanceof HTTPException) return err.getResponse()
    deps.logger.error({ err, path: c.req.path }, 'unhandled error')
    return c.json({ error: 'internal', message: 'Внутренняя ошибка' }, 500)
  })

  return app
}
```

- [ ] **Шаг 4: Тесты**

```bash
npx vitest run --project api   # 29 passed
pnpm --filter api typecheck && pnpm --filter api lint
```

- [ ] **Шаг 5: Commit**

```bash
git add -A && git commit -m "feat(api): settings endpoints and live SSE event stream"
```


---

### Задача 13: CLI: `admin:*` и `settings:*`

**Files:**
- Create: `apps/api/src/cli.ts`
- Test: `apps/api/test/cli.test.ts`

**Interfaces:**
- Produces: `node apps/api/src/cli.ts admin:create|admin:reset-password|admin:disable --login <l> [--password-stdin]`, `settings:get [key]`, `settings:set <key> <value> | --value-stdin`, `settings:reset <key>`;
  локально — `pnpm --filter api cli <команда>` (читает `.env`); в контейнере — `docker compose exec accs-api node apps/api/src/cli.ts <команда>`. Действия пишутся в аудит с `actor_type=cli`.

- [ ] **Шаг 1: Написать падающий тест (CLI запускается настоящим подпроцессом)**

`apps/api/test/cli.test.ts`

```ts
import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { admins, auditLog } from '@workspace/db'
import { createTestDatabase, type TestDatabase } from '@workspace/db/testing'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'

const run = promisify(execFile)
const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url))
let t: TestDatabase
let env: NodeJS.ProcessEnv

beforeAll(async () => {
  t = await createTestDatabase(inject('pgAdminUrl'))
  env = {
    ...process.env,
    DATABASE_URL: t.url,
    REDIS_URL: inject('redisUrl'),
    APP_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    PUBLIC_ORIGIN: 'https://panel.test',
  }
})
afterAll(async () => {
  await t.drop()
})

function cliRun(args: string[], input?: string) {
  const child = run(process.execPath, [cli, ...args], { env })
  if (input !== undefined) {
    child.child.stdin?.end(input)
  }
  return child
}

describe('cli', () => {
  it('creates an admin from stdin and audits it as cli', async () => {
    const { stdout } = await cliRun(['admin:create', '--login', 'root', '--password-stdin'], 'super secret pass\n')
    expect(stdout).toMatch(/admin created: root/)
    const [row] = await t.db.select().from(admins).where(eq(admins.login, 'root'))
    expect(row?.passwordHash).toMatch(/^\$argon2id\$/)
    const [audit] = await t.db.select().from(auditLog).where(eq(auditLog.action, 'admin.create'))
    expect(audit).toMatchObject({ actorType: 'cli', adminId: null })
  })

  it('rejects a short password with a clear message', async () => {
    await expect(cliRun(['admin:create', '--login', 'weak', '--password-stdin'], 'short\n')).rejects.toMatchObject({ stderr: expect.stringMatching(/не короче 10/) })
  })

  it('sets, shows and resets settings; secrets are never printed', async () => {
    await cliRun(['settings:set', 'worker.connectConcurrency', '12'])
    await cliRun(['settings:set', 'notify.botToken', '--value-stdin'], '123:SECRET\n')
    const { stdout } = await cliRun(['settings:get'])
    expect(stdout).toMatch(/worker\.connectConcurrency = 12\n/)
    expect(stdout).toMatch(/notify\.botToken = <set>/)
    expect(stdout).not.toContain('123:SECRET')
    await cliRun(['settings:reset', 'worker.connectConcurrency'])
    expect((await cliRun(['settings:get', 'worker.connectConcurrency'])).stdout).toMatch(/= 5 {2}\(default\)/)
    await expect(cliRun(['settings:set', 'worker.connectConcurrency', '0'])).rejects.toMatchObject({ stderr: expect.stringMatching(/Не меньше 1/) })
  })
})
```

- [ ] **Шаг 2: Убедиться, что тест падает**

```bash
npx vitest run --project api -t cli
# FAIL: Cannot find module .../src/cli.ts
```

- [ ] **Шаг 3: CLI**

Значение `settings:set` парсится как JSON, если возможно (`5`, `true`, `["code"]`), иначе берётся строкой; секреты — `--value-stdin`. Изменения настроек публикуются на шину — запущенные api/worker применяют их сразу.

`apps/api/src/cli.ts`

```ts
import { parseArgs } from 'node:util'
import promptPassword from '@inquirer/password'
import { createDb, type DbHandle } from '@workspace/db'
import { createEventBus, createRedis, SettingsService, writeAudit, type Redis } from '@workspace/server'
import { loginSchema, passwordSchema } from '@workspace/shared/api'
import { createCipher } from '@workspace/shared/crypto'
import { loadEnv, type Env } from '@workspace/shared/env'
import { isSettingKey, settingsDef } from '@workspace/shared/settings'
import { AdminError, createAdmin, disableAdmin, findAdminByLogin, setAdminPassword } from './services/admins.ts'

const USAGE = `Usage:
  cli admin:create --login <login> [--password-stdin]
  cli admin:reset-password --login <login> [--password-stdin]
  cli admin:disable --login <login>
  cli settings:get [<key>]
  cli settings:set <key> <value> | settings:set <key> --value-stdin
  cli settings:reset <key>

<value> is parsed as JSON when possible (5, true, ["code"]), otherwise taken as a string.`

class CliError extends Error {}

async function readStdin(): Promise<string> {
  let data = ''
  for await (const chunk of process.stdin) data += String(chunk)
  return data.replace(/\r?\n$/, '')
}

async function readPassword(fromStdin: boolean | undefined): Promise<string> {
  const value = fromStdin ? await readStdin() : await promptPassword({ message: 'Пароль:', mask: '*' })
  const parsed = passwordSchema.safeParse(value)
  if (!parsed.success) throw new CliError(parsed.error.issues[0]?.message ?? 'Неверный пароль')
  return parsed.data
}

function requireLogin(login: string | undefined): string {
  const parsed = loginSchema.safeParse(login ?? '')
  if (!parsed.success) throw new CliError(parsed.error.issues[0]?.message ?? '--login is required')
  return parsed.data
}

function parseValue(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}

async function withSettings<T>(env: Env, database: DbHandle, fn: (settings: SettingsService) => Promise<T>): Promise<T> {
  const pub: Redis = createRedis(env.REDIS_URL, 'cli')
  const sub: Redis = createRedis(env.REDIS_URL, 'cli-sub')
  try {
    const bus = await createEventBus({ publisher: pub, subscriber: sub })
    const settings = await SettingsService.create({ db: database.db, cipher: createCipher(env.APP_ENCRYPTION_KEY), bus })
    try {
      return await fn(settings)
    } finally {
      settings.close()
      await bus.close()
    }
  } finally {
    await Promise.allSettled([pub.quit(), sub.quit()])
  }
}

async function run(argv: string[]): Promise<void> {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      login: { type: 'string' },
      'password-stdin': { type: 'boolean' },
      'value-stdin': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  })
  const [command, ...args] = positionals
  if (!command || values.help) {
    console.log(USAGE)
    return
  }

  const env = loadEnv()
  const database = createDb(env.DATABASE_URL, { max: 2 })
  const { db } = database
  try {
    switch (command) {
      case 'admin:create': {
        const login = requireLogin(values.login)
        const admin = await createAdmin(db, { login, password: await readPassword(values['password-stdin']) })
        await writeAudit(db, { actor: { type: 'cli' }, action: 'admin.create', targetType: 'admin', targetId: admin.id, payload: { login }, result: 'ok' })
        console.log(`admin created: ${admin.login} (${admin.id})`)
        return
      }
      case 'admin:reset-password': {
        const login = requireLogin(values.login)
        const admin = await findAdminByLogin(db, login)
        if (!admin) throw new CliError(`admin not found: ${login}`)
        await setAdminPassword(db, admin.id, await readPassword(values['password-stdin']))
        await writeAudit(db, { actor: { type: 'cli' }, action: 'admin.password.reset', targetType: 'admin', targetId: admin.id, result: 'ok' })
        console.log(`password reset: ${login}`)
        return
      }
      case 'admin:disable': {
        const login = requireLogin(values.login)
        const admin = await findAdminByLogin(db, login)
        if (!admin) throw new CliError(`admin not found: ${login}`)
        await disableAdmin(db, admin.id)
        await writeAudit(db, { actor: { type: 'cli' }, action: 'admin.disable', targetType: 'admin', targetId: admin.id, result: 'ok' })
        console.log(`admin disabled: ${login}`)
        return
      }
      case 'settings:get': {
        await withSettings(env, database, async (settings) => {
          const snapshot = settings.snapshot()
          const keys = args[0] ? [args[0]] : Object.keys(snapshot)
          for (const key of keys) {
            if (!isSettingKey(key)) throw new CliError(`unknown setting: ${key}`)
            const state = snapshot[key]
            const shown = settingsDef[key].meta.type === 'secret' ? (state.isSet ? '<set>' : '<not set>') : JSON.stringify(state.value)
            console.log(`${key} = ${shown}${state.overridden ? '' : '  (default)'}`)
          }
        })
        return
      }
      case 'settings:set':
      case 'settings:reset': {
        const [key, rawValue] = args
        if (!key) throw new CliError(USAGE)
        let value: unknown = null
        if (command === 'settings:set') {
          if (values['value-stdin']) value = await readStdin()
          else if (rawValue !== undefined) value = parseValue(rawValue)
          else throw new CliError('value is required')
        }
        await withSettings(env, database, async (settings) => {
          const result = await settings.update({ [key]: value }, { adminId: null })
          if (!result.ok) throw new CliError(Object.entries(result.errors).map(([k, m]) => `${k}: ${m}`).join('\n'))
          await writeAudit(db, { actor: { type: 'cli' }, action: 'settings.update', payload: { diff: result.diff }, result: 'ok' })
          console.log(`${key} updated`)
        })
        return
      }
      default:
        throw new CliError(`unknown command: ${command}\n\n${USAGE}`)
    }
  } finally {
    await database.close()
  }
}

try {
  await run(process.argv.slice(2))
} catch (err) {
  if (err instanceof CliError) console.error(err.message)
  else if (err instanceof AdminError) console.error(`error: ${err.code}`)
  else console.error(err)
  process.exitCode = 1
}
```

- [ ] **Шаг 4: Тесты**

```bash
npx vitest run --project api   # 32 passed
pnpm --filter api typecheck && pnpm --filter api lint
```

- [ ] **Шаг 5: Commit**

```bash
git add -A && git commit -m "feat(api): admin and settings CLI"
```


---

### Задача 14: Docker, compose, `.env.example`, README

**Files:**
- Create: `Dockerfile`, `.dockerignore`, `compose.yml`, `compose.dev.yml`, `.env.example`, `README.md`

**Interfaces:**
- Produces: образ `accs-manager-api:local`; сервисы `accs-postgres`, `accs-redis`, `accs-migrate` (одноразовый), `accs-api` (порт `${API_BIND}:${API_PORT}`); тома `accs-pgdata`, `accs-redisdata`; сеть `accs-net`.

- [ ] **Шаг 1: Dockerfile**

Один образ `api` (статика web внутри); Node 26 исполняет TS из исходников, workspace-пакеты — симлинки pnpm (type stripping не работает внутри `node_modules`, поэтому без `pnpm deploy`).
В `web-build` нужен и `tsconfig.node.json`: Vite читает tsconfig пакета `shared`, который от него наследуется.

`Dockerfile`

```dockerfile
# syntax=docker/dockerfile:1.7
FROM node:26-trixie-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
# Node 26 ships without corepack
RUN npm i -g pnpm@12.8.2
WORKDIR /app

# ---- manifests only (cache-friendly) ----
FROM base AS manifests
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/db/package.json packages/db/
COPY packages/server/package.json packages/server/
COPY packages/shared/package.json packages/shared/
COPY packages/ui/package.json packages/ui/

# ---- build the SPA ----
FROM manifests AS web-build
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile --filter "web..."
COPY tsconfig.json tsconfig.node.json ./
COPY packages/ui packages/ui
COPY packages/shared packages/shared
COPY apps/web apps/web
RUN pnpm --filter web build

# ---- production deps of api and its workspace packages (symlinked, not injected) ----
FROM manifests AS api-deps
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile --prod --filter "api..."

# ---- runtime: Node runs the TypeScript sources directly (type stripping) ----
FROM node:26-trixie-slim AS api
ENV NODE_ENV=production
WORKDIR /app
COPY --from=api-deps --chown=node:node /app ./
COPY --chown=node:node packages/shared/src packages/shared/src
COPY --chown=node:node packages/db/src packages/db/src
COPY --chown=node:node packages/db/drizzle packages/db/drizzle
COPY --chown=node:node packages/server/src packages/server/src
COPY --chown=node:node apps/api/src apps/api/src
COPY --from=web-build --chown=node:node /app/apps/web/dist apps/web/dist
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s CMD ["node", "-e", "fetch('http://127.0.0.1:3000/api/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "apps/api/src/main.ts"]
```

`.dockerignore`

```
**/node_modules
**/dist
**/.turbo
.git
.env
.env.*
!.env.example
tdata-samples
*.zip
docs
e2e
test-results
playwright-report
coverage
```

- [ ] **Шаг 2: compose: всё с префиксом accs-**

Сервисы, контейнеры, тома и сеть — `accs-*`. Postgres 18 монтируется в `/var/lib/postgresql` (не `/data`). Redis — `noeviction` (BullMQ в плане 2).
`compose.dev.yml` публикует Postgres/Redis на localhost; порты настраиваются (`DEV_PG_PORT`/`DEV_REDIS_PORT`), если 5432/6379 заняты.

`compose.yml`

```yaml
name: accs-manager

# All services, containers, volumes and the network carry the "accs-" prefix
# so they are easy to tell apart in `docker ps` / `docker volume ls`.

x-api-image: &api-image
  image: accs-manager-api:local
  build:
    context: .
    target: api

x-db-url: &db-url postgres://accs:${POSTGRES_PASSWORD:?set POSTGRES_PASSWORD in .env}@accs-postgres:5432/accs

services:
  accs-postgres:
    image: postgres:18-trixie
    container_name: accs-postgres
    restart: unless-stopped
    environment:
      POSTGRES_USER: accs
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:?set POSTGRES_PASSWORD in .env}
      POSTGRES_DB: accs
    volumes:
      # Postgres 18 images keep PGDATA in a versioned subdirectory of /var/lib/postgresql
      - accs-pgdata:/var/lib/postgresql
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U accs -d accs"]
      interval: 5s
      timeout: 3s
      retries: 30

  accs-redis:
    image: redis:8-trixie
    container_name: accs-redis
    restart: unless-stopped
    # BullMQ (plan 2) requires noeviction
    command: ["redis-server", "--appendonly", "yes", "--maxmemory-policy", "noeviction"]
    volumes:
      - accs-redisdata:/data
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      timeout: 3s
      retries: 30

  accs-migrate:
    <<: *api-image
    container_name: accs-migrate
    command: ["node", "packages/db/src/migrate-cli.ts"]
    environment:
      DATABASE_URL: *db-url
    depends_on:
      accs-postgres:
        condition: service_healthy
    restart: "no"

  accs-api:
    <<: *api-image
    container_name: accs-api
    restart: unless-stopped
    environment:
      NODE_ENV: production
      PORT: 3000
      DATABASE_URL: *db-url
      REDIS_URL: redis://accs-redis:6379
      APP_ENCRYPTION_KEY: ${APP_ENCRYPTION_KEY:?set APP_ENCRYPTION_KEY in .env}
      PUBLIC_ORIGIN: ${PUBLIC_ORIGIN:?set PUBLIC_ORIGIN in .env}
      TRUST_PROXY: ${TRUST_PROXY:-false}
      LOG_LEVEL: ${LOG_LEVEL:-info}
    ports:
      - "${API_BIND:-127.0.0.1}:${API_PORT:-3000}:3000"
    depends_on:
      accs-migrate:
        condition: service_completed_successfully
      accs-redis:
        condition: service_healthy

volumes:
  accs-pgdata:
    name: accs-pgdata
  accs-redisdata:
    name: accs-redisdata

networks:
  default:
    name: accs-net
```

`compose.dev.yml`

```yaml
# Local development: only Postgres and Redis, published on localhost.
#   docker compose -f compose.yml -f compose.dev.yml up -d accs-postgres accs-redis
# Ports are configurable in case 5432/6379 are taken by other projects.
services:
  accs-postgres:
    ports:
      - "127.0.0.1:${DEV_PG_PORT:-5432}:5432"
  accs-redis:
    ports:
      - "127.0.0.1:${DEV_REDIS_PORT:-6379}:6379"
```

`.env.example`

```
# Infrastructure only. Everything else is configured in the admin panel (Settings).

# --- app (read by api / worker) ---
NODE_ENV=development
PORT=3000
# local dev (pnpm dev) talks to compose.dev.yml services; inside docker compose these two are overridden
DATABASE_URL=postgres://accs:change-me@localhost:5432/accs
REDIS_URL=redis://localhost:6379
# 32 random bytes, base64:  node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
APP_ENCRYPTION_KEY=
# external URL of the panel (cookie Secure flag + Origin check); dev: Vite on http://localhost:5173
PUBLIC_ORIGIN=http://localhost:5173
TRUST_PROXY=false
LOG_LEVEL=info

# --- docker compose only ---
POSTGRES_PASSWORD=change-me
API_BIND=127.0.0.1
API_PORT=3000
# compose.dev.yml: host ports for Postgres/Redis (change if 5432/6379 are taken; keep DATABASE_URL/REDIS_URL in sync)
DEV_PG_PORT=5432
DEV_REDIS_PORT=6379
```

`README.md`

````md
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
````

- [ ] **Шаг 3: Собрать и поднять стек, smoke через CLI и curl**

```bash
cp .env.example .env
node -e "console.log('APP_ENCRYPTION_KEY=' + require('crypto').randomBytes(32).toString('base64'))" >> .env   # и удалить пустую строку APP_ENCRYPTION_KEY=
sed -i '' 's#^PUBLIC_ORIGIN=.*#PUBLIC_ORIGIN=http://localhost:3000#' .env
docker compose up -d --build --wait
docker ps --format '{{.Names}} {{.Status}}' | grep accs-     # accs-api healthy, accs-postgres/accs-redis healthy
docker ps -a --format '{{.Names}} {{.Status}}' | grep accs-migrate   # Exited (0)
printf 'smoke password 123\n' | docker compose exec -T accs-api node apps/api/src/cli.ts admin:create --login root --password-stdin
curl -si -X POST http://127.0.0.1:3000/api/auth/login -H 'origin: http://localhost:3000' -H 'content-type: application/json' \
  -d '{"login":"root","password":"smoke password 123"}' | grep -iE '^HTTP|set-cookie'   # 200 + accs_session=...; HttpOnly; SameSite=Strict
curl -s -o /dev/null -w '%{http_code} %{content_type}\n' http://127.0.0.1:3000/some/route   # 200 text/html (SPA fallback; пока это каркас web)
docker compose down
```

- [ ] **Шаг 4: Commit**

```bash
git add -A && git commit -m "build: docker image, compose stack (accs-*), env example, readme"
```


---

### Задача 15: Web: вход, защищённый layout, навигация, главная

**Files:**
- Create: `apps/web/src/lib/{api,query-client,auth,settings,use-event-stream}.ts`, `apps/web/src/components/{nav-tabs,mobile-nav,connection-indicator,user-menu,password-input,change-password-dialog,app-header,page-header,setup-alert}.tsx`,
  `apps/web/src/routes/{__root,login,_authed}.tsx`, `apps/web/src/routes/_authed/{index,accounts,proxies,audit,admins,settings}.tsx`, `apps/web/src/test/setup.ts`, `apps/web/src/routeTree.gen.ts` (генерируется)
- Modify: `apps/web/{vite.config.ts,index.html,package.json}`, `apps/web/src/main.tsx`, `vitest.config.ts`, `packages/ui/src/components/*` (CLI)
- Delete: `apps/web/src/App.tsx`
- Test: `apps/web/src/components/nav-tabs.test.ts`, `apps/web/src/routes/auth-guard.test.tsx`

**Interfaces:**
- Consumes: `MeResponse`, `SettingsResponse`, `ApiError` (6), `appEventSchema` (5), `settingsDef`, `settingGroups` (3); API задач 9–12.
- Produces: `api<T>(path, init & { json? })`, класс `ApiError` (`status`, `fields`); `meQueryOptions`, `authKeys`; `settingsQueryOptions`; `useEventStream(onEvent) → 'connecting'|'open'|'reconnecting'`;
  `NAV_ITEMS`, `activeNavItem(pathname)`, `NavTabs`; `PageHeader`; `PasswordInput`; маршрутный контекст `{ me }` в `_authed`.

- [ ] **Шаг 1: Зависимости и компоненты shadcn**

```bash
pnpm --filter web add '@tanstack/react-router@^1' '@tanstack/react-query@^5' 'zod@^4' '@workspace/shared@workspace:*'
pnpm --filter web add -D '@tanstack/router-plugin@^1' '@testing-library/react@^16' '@testing-library/dom@^10' \
  '@testing-library/user-event@^14' '@testing-library/jest-dom@^7' 'jsdom@^30'
pnpm --filter web pkg set scripts.test='vitest run'
# компоненты кладутся в packages/ui/src/components; только CLI, руками не писать
npx shadcn@latest add tabs sheet dropdown-menu avatar card field input input-group badge alert empty tooltip dialog spinner separator toast -c apps/web -y
rm apps/web/src/App.tsx
```

- [ ] **Шаг 2: Vite: роутер (до react()), прокси /api, тесты; заглушки jsdom**

`apps/web/vite.config.ts`

```ts
/// <reference types="vitest/config" />
import { resolve } from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import { tanstackRouter } from '@tanstack/router-plugin/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const API_TARGET = process.env.VITE_API_TARGET ?? 'http://localhost:3000'

export default defineConfig({
  plugins: [
    // must come before react()
    tanstackRouter({ target: 'react', autoCodeSplitting: true, routeFileIgnorePattern: '\\.test\\.tsx?$' }),
    react(),
    tailwindcss(),
  ],
  resolve: { alias: { '@': resolve(import.meta.dirname, './src') } },
  server: {
    proxy: { '/api': { target: API_TARGET, changeOrigin: true } },
  },
  test: {
    name: 'web',
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    css: false,
  },
})
```

`apps/web/src/test/setup.ts`

```ts
import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach, vi } from 'vitest'

afterEach(() => cleanup())

// jsdom has no matchMedia; the scaffold ThemeProvider uses it
if (typeof window.matchMedia !== 'function') {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  })
}

// jsdom has no scrollTo; the router's scroll restoration calls it
window.scrollTo = vi.fn() as unknown as typeof window.scrollTo
```

`apps/web/index.html`

```html
<!doctype html>
<html lang="ru">
  <head>
    <meta charset="UTF-8" />
    <link rel="icon" type="image/svg+xml" href="/vite.svg" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>accs-manager</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

`vitest.config.ts`

```ts
import { defineConfig } from 'vitest/config'

const integration = { testTimeout: 30_000, hookTimeout: 120_000 }

export default defineConfig({
  test: {
    // starts Postgres 18 + Redis 8 once for the whole run; URLs reach every project via provide/inject
    globalSetup: ['./vitest.global-setup.ts'],
    projects: [
      { test: { name: 'shared', root: './packages/shared', environment: 'node' } },
      { test: { name: 'db', root: './packages/db', environment: 'node', ...integration } },
      { test: { name: 'server', root: './packages/server', environment: 'node', ...integration } },
      { test: { name: 'api', root: './apps/api', environment: 'node', ...integration } },
      // folder project: uses apps/web/vite.config.ts (jsdom, setup file)
      'apps/web',
    ],
  },
})
```

- [ ] **Шаг 3: Написать падающие тесты**

`apps/web/src/components/nav-tabs.test.ts`

```ts
import { describe, expect, it } from 'vitest'
import { activeNavItem } from './nav-tabs'

describe('activeNavItem', () => {
  it('matches the root only exactly', () => {
    expect(activeNavItem('/')).toBe('/')
    expect(activeNavItem('/settings')).toBe('/settings')
  })
  it('matches nested routes and ignores lookalikes', () => {
    expect(activeNavItem('/accounts/42')).toBe('/accounts')
    expect(activeNavItem('/accountsx')).toBeNull()
    expect(activeNavItem('/login')).toBeNull()
  })
})
```

`apps/web/src/routes/auth-guard.test.tsx`

```tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router'
import { render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { routeTree } from '@/routeTree.gen'

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

function setup(path: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const router = createRouter({ routeTree, context: { queryClient }, history: createMemoryHistory({ initialEntries: [path] }) })
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
  return router
}

class SilentEventSource extends EventTarget {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSED = 2
  readyState = 0
  onerror: (() => void) | null = null
  close() {}
}

afterEach(() => vi.unstubAllGlobals())

it('redirects anonymous users to /login and keeps the target', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => json({ error: 'unauthorized' }, 401)))
  const router = setup('/settings?group=proxy')
  await waitFor(() => expect(router.state.location.pathname).toBe('/login'))
  expect(router.state.location.search).toEqual({ redirect: '/settings?group=proxy' })
  expect(await screen.findByRole('button', { name: 'Войти' })).toBeInTheDocument()
})

it('renders the shell with the active tab for signed-in admins', async () => {
  vi.stubGlobal('EventSource', SilentEventSource)
  vi.stubGlobal('fetch', vi.fn(async (url: string) => (url.endsWith('/auth/me') ? json({ id: 'a1', login: 'root' }) : json({ items: {} }))))
  setup('/')
  expect(await screen.findByRole('heading', { name: 'Коды' })).toBeInTheDocument()
  expect(screen.getAllByRole('tab', { name: 'Коды' })[0]).toHaveAttribute('aria-selected', 'true')
})
```

- [ ] **Шаг 4: Убедиться, что тесты падают**

```bash
npx vitest run --project web
# FAIL: Cannot find module ./nav-tabs / @/routeTree.gen
```

- [ ] **Шаг 5: Клиент API, запросы, поток событий**

`queryClient.query({ ...opts, staleTime: 'static' })` — замена устаревшего в Query 5.104 `ensureQueryData`.
EventSource: при `CONNECTING` браузер переподключается сам; при `CLOSED` (например, 401) — переподключаемся с backoff.

`apps/web/src/lib/api.ts`

```ts
import type { ApiError as ApiErrorBody } from '@workspace/shared/api'

export class ApiError extends Error {
  readonly status: number
  readonly body: ApiErrorBody | null
  constructor(status: number, body: ApiErrorBody | null) {
    super(body?.message ?? `HTTP ${status}`)
    this.name = 'ApiError'
    this.status = status
    this.body = body
  }
  /** per-field validation messages from a 400 response */
  get fields(): Record<string, string> {
    return this.body?.fields ?? {}
  }
}

/** Same-origin JSON fetch to /api; throws ApiError for non-2xx. */
export async function api<T>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const { json, ...rest } = init
  const headers = new Headers(rest.headers)
  if (json !== undefined) headers.set('content-type', 'application/json')
  const res = await fetch(`/api${path}`, { ...rest, headers, ...(json !== undefined ? { body: JSON.stringify(json) } : {}) })
  if (!res.ok) {
    let body: ApiErrorBody | null = null
    try {
      body = (await res.json()) as ApiErrorBody
    } catch {
      // not JSON
    }
    throw new ApiError(res.status, body)
  }
  if (res.status === 204) return undefined as T
  return (await res.json()) as T
}
```

`apps/web/src/lib/query-client.ts`

```ts
import { QueryClient } from '@tanstack/react-query'
import { ApiError } from './api'

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        refetchOnWindowFocus: false,
        retry: (count, err) => !(err instanceof ApiError && err.status < 500) && count < 2,
      },
    },
  })
}
```

`apps/web/src/lib/auth.ts`

```ts
import { queryOptions } from '@tanstack/react-query'
import type { MeResponse } from '@workspace/shared/api'
import { api, ApiError } from './api'

export const authKeys = { me: ['auth', 'me'] as const }

/** 401 is an expected state → resolves to null. */
export const meQueryOptions = queryOptions({
  queryKey: authKeys.me,
  queryFn: async ({ signal }): Promise<MeResponse | null> => {
    try {
      return await api<MeResponse>('/auth/me', { signal })
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return null
      throw err
    }
  },
  staleTime: 5 * 60_000,
  retry: false,
})
```

`apps/web/src/lib/settings.ts`

```ts
import { queryOptions } from '@tanstack/react-query'
import type { SettingsResponse } from '@workspace/shared/api'
import { api } from './api'

export const settingsQueryOptions = queryOptions({
  queryKey: ['settings'] as const,
  queryFn: ({ signal }) => api<SettingsResponse>('/settings', { signal }),
})
```

`apps/web/src/lib/use-event-stream.ts`

```ts
import * as React from 'react'
import { appEventSchema, type AppEvent } from '@workspace/shared/events'

export type StreamStatus = 'connecting' | 'open' | 'reconnecting'

/**
 * One EventSource to /api/events for the whole app. Reconnects with backoff when the browser
 * gives up (e.g. after a 401 or a deploy). Named events only; 'ready'/'ping' are keep-alives.
 */
export function useEventStream(onEvent: (event: AppEvent) => void, maxBackoffMs = 30_000): StreamStatus {
  const [status, setStatus] = React.useState<StreamStatus>('connecting')
  const onEventRef = React.useRef(onEvent)
  React.useEffect(() => {
    onEventRef.current = onEvent
  })

  React.useEffect(() => {
    let source: EventSource | null = null
    let attempt = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    let disposed = false

    const handle = (ev: MessageEvent<string>) => {
      const parsed = appEventSchema.safeParse(JSON.parse(ev.data))
      if (parsed.success) onEventRef.current(parsed.data)
    }

    const connect = () => {
      source = new EventSource('/api/events')
      source.addEventListener('ready', () => {
        attempt = 0
        setStatus('open')
      })
      source.onerror = () => {
        if (!source) return
        if (source.readyState === EventSource.CONNECTING) {
          setStatus('reconnecting')
          return
        }
        source.close()
        if (disposed) return
        setStatus('reconnecting')
        timer = setTimeout(connect, Math.min(maxBackoffMs, 1000 * 2 ** attempt++))
      }
      for (const type of appEventSchema.options.map((o) => o.shape.type.value)) {
        source.addEventListener(type, handle as EventListener)
      }
    }

    connect()
    return () => {
      disposed = true
      clearTimeout(timer)
      source?.close()
    }
  }, [maxBackoffMs])

  return status
}
```

- [ ] **Шаг 6: Шапка: табы-ссылки, мобильный Sheet, меню админа, смена пароля**

Навигация — `Tabs` + `TabsList variant="line"`; триггеры — ссылки роутера (`nativeButton={false} render={<Link/>}`), обёрнуты в `<nav>`.
На `< md` табы скрыты, бургер открывает `Sheet` слева с теми же табами `orientation="vertical"`.

`apps/web/src/components/nav-tabs.tsx`

```tsx
import { Link, useRouterState } from '@tanstack/react-router'
import { Tabs, TabsList, TabsTrigger } from '@workspace/ui/components/tabs'
import { KeyRoundIcon, NetworkIcon, ScrollTextIcon, SettingsIcon, ShieldIcon, UsersIcon } from 'lucide-react'

export const NAV_ITEMS = [
  { to: '/', label: 'Коды', icon: KeyRoundIcon },
  { to: '/accounts', label: 'Аккаунты', icon: UsersIcon },
  { to: '/proxies', label: 'Прокси', icon: NetworkIcon },
  { to: '/audit', label: 'Аудит', icon: ScrollTextIcon },
  { to: '/admins', label: 'Админы', icon: ShieldIcon },
  { to: '/settings', label: 'Настройки', icon: SettingsIcon },
] as const

export function activeNavItem(pathname: string): string | null {
  const match = NAV_ITEMS.find((item) => (item.to === '/' ? pathname === '/' : pathname === item.to || pathname.startsWith(`${item.to}/`)))
  return match?.to ?? null
}

/** Route links rendered as line tabs: built-in Tabs styling, real <a> navigation. */
export function NavTabs({ orientation = 'horizontal', onNavigate }: { orientation?: 'horizontal' | 'vertical'; onNavigate?: () => void }) {
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  return (
    <Tabs value={activeNavItem(pathname)} orientation={orientation}>
      <TabsList variant="line" aria-label="Разделы">
        {NAV_ITEMS.map((item) => (
          <TabsTrigger key={item.to} value={item.to} nativeButton={false} render={<Link to={item.to} onClick={onNavigate} />}>
            <item.icon data-icon="inline-start" />
            {item.label}
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  )
}
```

`apps/web/src/components/mobile-nav.tsx`

```tsx
import * as React from 'react'
import { Button } from '@workspace/ui/components/button'
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from '@workspace/ui/components/sheet'
import { MenuIcon } from 'lucide-react'
import { NavTabs } from './nav-tabs'

export function MobileNav() {
  const [open, setOpen] = React.useState(false)
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger render={<Button variant="ghost" size="icon" aria-label="Открыть меню" />}>
        <MenuIcon />
      </SheetTrigger>
      <SheetContent side="left">
        <SheetHeader>
          <SheetTitle>accs-manager</SheetTitle>
        </SheetHeader>
        <div className="px-4">
          <NavTabs orientation="vertical" onNavigate={() => setOpen(false)} />
        </div>
      </SheetContent>
    </Sheet>
  )
}
```

`apps/web/src/components/connection-indicator.tsx`

```tsx
import { Badge } from '@workspace/ui/components/badge'
import type { StreamStatus } from '@/lib/use-event-stream'

const LABELS: Record<StreamStatus, string> = { open: 'Онлайн', connecting: 'Подключение…', reconnecting: 'Нет связи' }

export function ConnectionIndicator({ status }: { status: StreamStatus }) {
  return (
    <Badge variant={status === 'open' ? 'secondary' : 'destructive'} aria-live="polite" title="Живые обновления">
      {LABELS[status]}
    </Badge>
  )
}
```

`apps/web/src/components/user-menu.tsx`

```tsx
import { useQueryClient } from '@tanstack/react-query'
import { useRouter } from '@tanstack/react-router'
import { Avatar, AvatarFallback } from '@workspace/ui/components/avatar'
import { Button } from '@workspace/ui/components/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@workspace/ui/components/dropdown-menu'
import { KeyIcon, LogOutIcon } from 'lucide-react'
import { api } from '@/lib/api'
import { authKeys } from '@/lib/auth'

export function UserMenu({ login, onChangePassword }: { login: string; onChangePassword: () => void }) {
  const queryClient = useQueryClient()
  const router = useRouter()
  const logout = async () => {
    await api('/auth/logout', { method: 'POST' })
    queryClient.clear()
    queryClient.setQueryData(authKeys.me, null)
    await router.invalidate()
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant="ghost" aria-label="Меню пользователя" />}>
        <Avatar className="size-6">
          <AvatarFallback>{login.slice(0, 2).toUpperCase()}</AvatarFallback>
        </Avatar>
        <span className="hidden sm:inline">{login}</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuGroup>
          <DropdownMenuLabel>{login}</DropdownMenuLabel>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuItem onClick={onChangePassword}>
            <KeyIcon />
            Сменить пароль
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => void logout()}>
            <LogOutIcon />
            Выйти
          </DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
```

`apps/web/src/components/password-input.tsx`

```tsx
import * as React from 'react'
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from '@workspace/ui/components/input-group'
import { EyeIcon, EyeOffIcon } from 'lucide-react'

export function PasswordInput(props: Omit<React.ComponentProps<typeof InputGroupInput>, 'type'>) {
  const [visible, setVisible] = React.useState(false)
  return (
    <InputGroup>
      <InputGroupInput type={visible ? 'text' : 'password'} {...props} />
      <InputGroupAddon align="inline-end">
        <InputGroupButton size="icon-xs" aria-label={visible ? 'Скрыть' : 'Показать'} onClick={() => setVisible((v) => !v)}>
          {visible ? <EyeOffIcon /> : <EyeIcon />}
        </InputGroupButton>
      </InputGroupAddon>
    </InputGroup>
  )
}
```

`apps/web/src/components/change-password-dialog.tsx`

```tsx
import * as React from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useRouter } from '@tanstack/react-router'
import { Button } from '@workspace/ui/components/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@workspace/ui/components/dialog'
import { Field, FieldError, FieldGroup, FieldLabel } from '@workspace/ui/components/field'
import { Spinner } from '@workspace/ui/components/spinner'
import { toast } from '@workspace/ui/components/toast'
import { api, ApiError } from '@/lib/api'
import { authKeys } from '@/lib/auth'
import { PasswordInput } from './password-input'

export function ChangePasswordDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const queryClient = useQueryClient()
  const router = useRouter()
  const [currentPassword, setCurrentPassword] = React.useState('')
  const [newPassword, setNewPassword] = React.useState('')
  const mutation = useMutation({
    mutationFn: () => api('/auth/password', { method: 'POST', json: { currentPassword, newPassword } }),
    onSuccess: async () => {
      onOpenChange(false)
      toast.add({ title: 'Пароль изменён', description: 'Войдите с новым паролем.' })
      queryClient.clear()
      queryClient.setQueryData(authKeys.me, null)
      await router.invalidate()
    },
  })
  const fields = mutation.error instanceof ApiError ? mutation.error.fields : {}

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form
          className="flex flex-col gap-6"
          onSubmit={(e) => {
            e.preventDefault()
            mutation.mutate()
          }}
        >
          <DialogHeader>
            <DialogTitle>Сменить пароль</DialogTitle>
            <DialogDescription>После смены все ваши сессии будут завершены.</DialogDescription>
          </DialogHeader>
          <FieldGroup>
            <Field data-invalid={fields.currentPassword ? true : undefined}>
              <FieldLabel htmlFor="current-password">Текущий пароль</FieldLabel>
              <PasswordInput id="current-password" autoComplete="current-password" required value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)} aria-invalid={fields.currentPassword ? true : undefined} />
              {fields.currentPassword && <FieldError>{fields.currentPassword}</FieldError>}
            </Field>
            <Field data-invalid={fields.newPassword ? true : undefined}>
              <FieldLabel htmlFor="new-password">Новый пароль</FieldLabel>
              <PasswordInput id="new-password" autoComplete="new-password" required minLength={10} value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)} aria-invalid={fields.newPassword ? true : undefined} />
              {fields.newPassword && <FieldError>{fields.newPassword}</FieldError>}
            </Field>
          </FieldGroup>
          <DialogFooter>
            <Button type="submit" disabled={mutation.isPending}>
              {mutation.isPending && <Spinner data-icon="inline-start" />}
              Сменить
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
```

`apps/web/src/components/app-header.tsx`

```tsx
import * as React from 'react'
import { Separator } from '@workspace/ui/components/separator'
import type { StreamStatus } from '@/lib/use-event-stream'
import { ChangePasswordDialog } from './change-password-dialog'
import { ConnectionIndicator } from './connection-indicator'
import { MobileNav } from './mobile-nav'
import { NavTabs } from './nav-tabs'
import { UserMenu } from './user-menu'

/** Top navbar with tabs on desktop; collapses into a Sheet on mobile (< md). */
export function AppHeader({ login, streamStatus }: { login: string; streamStatus: StreamStatus }) {
  const [passwordOpen, setPasswordOpen] = React.useState(false)
  return (
    <header className="bg-background sticky top-0 z-10 border-b">
      <div className="mx-auto flex h-14 max-w-7xl items-center gap-3 px-4 md:px-6">
        <div className="md:hidden">
          <MobileNav />
        </div>
        <span className="font-heading font-semibold">accs-manager</span>
        <Separator orientation="vertical" className="hidden h-6 md:block" />
        <nav className="hidden md:flex" aria-label="Основная навигация">
          <NavTabs />
        </nav>
        <div className="ml-auto flex items-center gap-2">
          <ConnectionIndicator status={streamStatus} />
          <UserMenu login={login} onChangePassword={() => setPasswordOpen(true)} />
        </div>
      </div>
      <ChangePasswordDialog open={passwordOpen} onOpenChange={setPasswordOpen} />
    </header>
  )
}
```

`apps/web/src/components/page-header.tsx`

```tsx
import type * as React from 'react'

export function PageHeader({ title, description, actions }: { title: string; description?: string; actions?: React.ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div className="flex flex-col gap-1">
        <h1 className="font-heading text-2xl font-semibold">{title}</h1>
        {description && <p className="text-muted-foreground text-sm">{description}</p>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  )
}
```

`apps/web/src/components/setup-alert.tsx`

```tsx
import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { settingGroups, settingsDef, type SettingKey } from '@workspace/shared/settings'
import { Alert, AlertAction, AlertDescription, AlertTitle } from '@workspace/ui/components/alert'
import { Button } from '@workspace/ui/components/button'
import { TriangleAlertIcon } from 'lucide-react'
import { settingsQueryOptions } from '@/lib/settings'

/** Lists required settings that have no value yet (spec §9: empty required values disable features). */
export function SetupAlert() {
  const { data } = useQuery(settingsQueryOptions)
  if (!data) return null
  const missing = (Object.keys(settingsDef) as SettingKey[]).filter((key) => settingsDef[key].meta.required && !data.items[key]?.isSet)
  if (missing.length === 0) return null
  const groups = settingGroups.filter((g) => missing.some((key) => settingsDef[key].meta.group === g.id))
  return (
    <Alert>
      <TriangleAlertIcon />
      <AlertTitle>Настройка не завершена</AlertTitle>
      <AlertDescription>
        Не заполнено обязательных параметров: {missing.length} ({groups.map((g) => g.label).join(', ')}). Без них часть функций выключена.
      </AlertDescription>
      <AlertAction>
        <Button size="sm" variant="outline" render={<Link to="/settings" />} nativeButton={false}>
          К настройкам
        </Button>
      </AlertAction>
    </Alert>
  )
}
```

- [ ] **Шаг 7: Маршруты: корень, вход, защищённый layout, главная, заглушки разделов**

`login.tsx` принимает только относительный `redirect` (без open redirect). `_authed` по `settings.changed` инвалидирует настройки и показывает toast, если менял не текущий админ.
Заглушки `audit`, `admins`, `settings` заменят задачи 16–17; `accounts`, `proxies` — планы 2–3.

`apps/web/src/routes/__root.tsx`

```tsx
import type { QueryClient } from '@tanstack/react-query'
import { createRootRouteWithContext, Outlet } from '@tanstack/react-router'
import { Toaster } from '@workspace/ui/components/toast'
import { TooltipProvider } from '@workspace/ui/components/tooltip'

export interface RouterContext {
  queryClient: QueryClient
}

export const Route = createRootRouteWithContext<RouterContext>()({
  component: () => (
    <TooltipProvider>
      <Toaster>
        <Outlet />
      </Toaster>
    </TooltipProvider>
  ),
})
```

`apps/web/src/routes/login.tsx`

```tsx
import * as React from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, redirect, useRouter } from '@tanstack/react-router'
import type { MeResponse } from '@workspace/shared/api'
import { Alert, AlertDescription } from '@workspace/ui/components/alert'
import { Button } from '@workspace/ui/components/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@workspace/ui/components/card'
import { Field, FieldGroup, FieldLabel } from '@workspace/ui/components/field'
import { Input } from '@workspace/ui/components/input'
import { Spinner } from '@workspace/ui/components/spinner'
import { z } from 'zod'
import { PasswordInput } from '@/components/password-input'
import { api, ApiError } from '@/lib/api'
import { authKeys, meQueryOptions } from '@/lib/auth'

const loginSearch = z.object({
  // app-relative only — no open redirects
  redirect: z.string().regex(/^\/(?!\/)/).optional().catch(undefined),
})

export const Route = createFileRoute('/login')({
  validateSearch: loginSearch,
  beforeLoad: async ({ context, search }) => {
    const me = await context.queryClient.query({ ...meQueryOptions, staleTime: 'static' })
    if (me) throw redirect({ href: search.redirect ?? '/' })
  },
  component: LoginPage,
})

function LoginPage() {
  const search = Route.useSearch()
  const router = useRouter()
  const queryClient = useQueryClient()
  const [login, setLogin] = React.useState('')
  const [password, setPassword] = React.useState('')
  const mutation = useMutation({
    mutationFn: () => api<MeResponse>('/auth/login', { method: 'POST', json: { login, password } }),
    onSuccess: async (me) => {
      queryClient.setQueryData(authKeys.me, me)
      await router.navigate({ href: search.redirect ?? '/' })
    },
  })
  const error = mutation.error instanceof ApiError ? mutation.error.message : mutation.error ? 'Не удалось войти' : null

  return (
    <main className="bg-muted flex min-h-svh items-center justify-center p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>accs-manager</CardTitle>
          <CardDescription>Вход в панель управления</CardDescription>
        </CardHeader>
        <CardContent>
          <form
            onSubmit={(e) => {
              e.preventDefault()
              mutation.mutate()
            }}
          >
            <FieldGroup>
              {error && (
                <Alert variant="destructive">
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              )}
              <Field>
                <FieldLabel htmlFor="login">Логин</FieldLabel>
                <Input id="login" autoComplete="username" autoFocus required value={login} onChange={(e) => setLogin(e.target.value)} />
              </Field>
              <Field>
                <FieldLabel htmlFor="password">Пароль</FieldLabel>
                <PasswordInput id="password" autoComplete="current-password" required value={password}
                  onChange={(e) => setPassword(e.target.value)} />
              </Field>
              <Button type="submit" disabled={mutation.isPending}>
                {mutation.isPending && <Spinner data-icon="inline-start" />}
                Войти
              </Button>
            </FieldGroup>
          </form>
        </CardContent>
      </Card>
    </main>
  )
}
```

`apps/web/src/routes/_authed.tsx`

```tsx
import { useQueryClient } from '@tanstack/react-query'
import { createFileRoute, Outlet, redirect } from '@tanstack/react-router'
import { toast } from '@workspace/ui/components/toast'
import { AppHeader } from '@/components/app-header'
import { meQueryOptions } from '@/lib/auth'
import { settingsQueryOptions } from '@/lib/settings'
import { useEventStream } from '@/lib/use-event-stream'

export const Route = createFileRoute('/_authed')({
  beforeLoad: async ({ context, location }) => {
    const me = await context.queryClient.query({ ...meQueryOptions, staleTime: 'static' })
    if (!me) throw redirect({ to: '/login', search: { redirect: location.href } })
    return { me }
  },
  component: AuthedLayout,
})

function AuthedLayout() {
  const { me } = Route.useRouteContext()
  const queryClient = useQueryClient()
  const streamStatus = useEventStream((event) => {
    if (event.type === 'settings.changed') {
      void queryClient.invalidateQueries({ queryKey: settingsQueryOptions.queryKey })
      if (event.by !== me.id) toast.add({ title: 'Настройки изменены', description: 'Другой админ или CLI обновил настройки.' })
    }
  })
  return (
    <div className="flex min-h-svh flex-col">
      <AppHeader login={me.login} streamStatus={streamStatus} />
      <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-6 md:px-6">
        <Outlet />
      </main>
    </div>
  )
}
```

`apps/web/src/routes/_authed/index.tsx`

```tsx
import { createFileRoute, Link } from '@tanstack/react-router'
import { Button } from '@workspace/ui/components/button'
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@workspace/ui/components/empty'
import { KeyRoundIcon } from 'lucide-react'
import { PageHeader } from '@/components/page-header'
import { SetupAlert } from '@/components/setup-alert'

export const Route = createFileRoute('/_authed/')({
  component: CodesPage,
})

function CodesPage() {
  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Коды" description="Коды авторизации из служебного чата Telegram всех аккаунтов — в реальном времени." />
      <SetupAlert />
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
    </div>
  )
}
```

`apps/web/src/routes/_authed/accounts.tsx`

```tsx
import { createFileRoute } from '@tanstack/react-router'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@workspace/ui/components/empty'
import { UsersIcon } from 'lucide-react'
import { PageHeader } from '@/components/page-header'

export const Route = createFileRoute('/_authed/accounts')({
  component: () => (
    <div className="flex flex-col gap-6">
      <PageHeader title="Аккаунты" description="Список аккаунтов, импорт tdata и вход по QR." />
      <Empty className="border">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <UsersIcon />
          </EmptyMedia>
          <EmptyTitle>Раздел в разработке</EmptyTitle>
          <EmptyDescription>Здесь скоро появится содержимое.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    </div>
  ),
})
```

`apps/web/src/routes/_authed/proxies.tsx`

```tsx
import { createFileRoute } from '@tanstack/react-router'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@workspace/ui/components/empty'
import { NetworkIcon } from 'lucide-react'
import { PageHeader } from '@/components/page-header'

export const Route = createFileRoute('/_authed/proxies')({
  component: () => (
    <div className="flex flex-col gap-6">
      <PageHeader title="Прокси" description="Пул прокси, проверки и синхронизация с proxy-store." />
      <Empty className="border">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <NetworkIcon />
          </EmptyMedia>
          <EmptyTitle>Раздел в разработке</EmptyTitle>
          <EmptyDescription>Здесь скоро появится содержимое.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    </div>
  ),
})
```

`apps/web/src/routes/_authed/audit.tsx`

```tsx
import { createFileRoute } from '@tanstack/react-router'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@workspace/ui/components/empty'
import { ScrollTextIcon } from 'lucide-react'
import { PageHeader } from '@/components/page-header'

export const Route = createFileRoute('/_authed/audit')({
  component: () => (
    <div className="flex flex-col gap-6">
      <PageHeader title="Аудит" description="Журнал действий админов и системы." />
      <Empty className="border">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <ScrollTextIcon />
          </EmptyMedia>
          <EmptyTitle>Раздел в разработке</EmptyTitle>
          <EmptyDescription>Здесь скоро появится содержимое.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    </div>
  ),
})
```

`apps/web/src/routes/_authed/admins.tsx`

```tsx
import { createFileRoute } from '@tanstack/react-router'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@workspace/ui/components/empty'
import { ShieldIcon } from 'lucide-react'
import { PageHeader } from '@/components/page-header'

export const Route = createFileRoute('/_authed/admins')({
  component: () => (
    <div className="flex flex-col gap-6">
      <PageHeader title="Админы" description="Админы панели." />
      <Empty className="border">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <ShieldIcon />
          </EmptyMedia>
          <EmptyTitle>Раздел в разработке</EmptyTitle>
          <EmptyDescription>Здесь скоро появится содержимое.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    </div>
  ),
})
```

`apps/web/src/routes/_authed/settings.tsx`

```tsx
import { createFileRoute } from '@tanstack/react-router'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@workspace/ui/components/empty'
import { SettingsIcon } from 'lucide-react'
import { PageHeader } from '@/components/page-header'

export const Route = createFileRoute('/_authed/settings')({
  component: () => (
    <div className="flex flex-col gap-6">
      <PageHeader title="Настройки" description="Типизированные настройки без перезапуска." />
      <Empty className="border">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <SettingsIcon />
          </EmptyMedia>
          <EmptyTitle>Раздел в разработке</EmptyTitle>
          <EmptyDescription>Здесь скоро появится содержимое.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    </div>
  ),
})
```


`apps/web/src/main.tsx`

```tsx
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClientProvider } from '@tanstack/react-query'
import { createRouter, RouterProvider } from '@tanstack/react-router'
import '@workspace/ui/globals.css'
import { ThemeProvider } from '@/components/theme-provider.tsx'
import { createQueryClient } from '@/lib/query-client'
import { routeTree } from './routeTree.gen'

const queryClient = createQueryClient()

const router = createRouter({
  routeTree,
  context: { queryClient },
  defaultPreload: 'intent',
  defaultPreloadStaleTime: 0,
  scrollRestoration: true,
})

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </ThemeProvider>
  </StrictMode>,
)
```

`src/routeTree.gen.ts` генерирует плагин роутера при `vite`/`vitest` — файл коммитится (без него `tsc -b` падает).

- [ ] **Шаг 8: Тесты, typecheck, lint, сборка**

```bash
npx vitest run --project web   # 4 passed
pnpm --filter web typecheck && pnpm --filter web lint && pnpm --filter web build
```

- [ ] **Шаг 9: Проверить в браузере**

```bash
docker compose -f compose.yml -f compose.dev.yml up -d accs-postgres accs-redis   # .env из задачи 14
pnpm --filter @workspace/db db:migrate && pnpm --filter api cli admin:create --login admin
pnpm dev   # http://localhost:5173 → вход → «Коды»; сузить окно < 768px → бургер и Sheet
```

- [ ] **Шаг 10: Commit**

```bash
git add -A && git commit -m "feat(web): app shell — login, guarded layout, navbar tabs, mobile sheet, live connection"
```


---

### Задача 16: Web: раздел «Настройки»

**Files:**
- Create: `apps/web/src/components/settings/{draft.ts,setting-field.tsx,settings-group-card.tsx}`
- Modify: `apps/web/src/routes/_authed/settings.tsx` (заглушка → страница), `packages/ui/src/components/*` (CLI)
- Test: `apps/web/src/components/settings/settings-group-card.test.tsx`

**Interfaces:**
- Consumes: `settingsDef`, `settingGroups` (3), `SettingsResponse` (6), `PATCH /api/settings` (12), `settingsQueryOptions`, `api` (15).
- Produces: `type Draft = { kind: 'set'; value } | { kind: 'reset' }`, `draftError(key, draft)`, `draftsToChanges(drafts)`; `SettingField`; `SettingsGroupCard({ group, data })`.

- [ ] **Шаг 1: Компоненты shadcn**

```bash
npx shadcn@latest add switch select checkbox textarea -c apps/web -y
```

- [ ] **Шаг 2: Написать падающий тест**

`apps/web/src/components/settings/settings-group-card.test.tsx`

```tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { SettingsResponse } from '@workspace/shared/api'
import { settingGroups, settingsDef, type SettingKey } from '@workspace/shared/settings'
import { Toaster } from '@workspace/ui/components/toast'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SettingsGroupCard } from './settings-group-card'

function snapshot(overrides: Partial<Record<SettingKey, Partial<SettingsResponse['items'][string]>>> = {}): SettingsResponse {
  const items: SettingsResponse['items'] = {}
  for (const key of Object.keys(settingsDef) as SettingKey[]) {
    const isSecret = settingsDef[key].meta.type === 'secret'
    const value = isSecret ? null : settingsDef[key].default
    items[key] = { value, isSet: value !== null, overridden: false, updatedAt: null, updatedBy: null, ...overrides[key] }
  }
  return { items }
}

function renderGroup(groupId: (typeof settingGroups)[number]['id'], data = snapshot()) {
  const group = settingGroups.find((g) => g.id === groupId)!
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <Toaster>
        <SettingsGroupCard group={group} data={data} />
      </Toaster>
    </QueryClientProvider>,
  )
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

afterEach(() => vi.unstubAllGlobals())

describe('SettingsGroupCard', () => {
  it('validates with the shared schema and blocks saving invalid values', async () => {
    const user = userEvent.setup()
    renderGroup('worker')
    const input = screen.getByLabelText('Параллельных подключений')
    await user.clear(input)
    await user.type(input, '0')
    expect(await screen.findByText('Не меньше 1')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Сохранить' })).toBeDisabled()
  })

  it('sends only changed keys and toggles booleans', async () => {
    const fetchMock = vi.fn(async () => json(snapshot()))
    vi.stubGlobal('fetch', fetchMock)
    const user = userEvent.setup()
    renderGroup('notifications')
    await user.click(screen.getByRole('switch', { name: 'Уведомления включены' }))
    await user.click(screen.getByRole('checkbox', { name: 'Аккаунт заморожен' }))
    await user.click(screen.getByRole('button', { name: 'Сохранить' }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('/api/settings')
    expect(init.method).toBe('PATCH')
    expect(JSON.parse(String(init.body))).toEqual({
      changes: { 'notify.enabled': true, 'notify.events': ['code', 'proxy_down', 'unauthorized', 'banned', 'proxy_expiring'] },
    })
  })

  it('replaces and clears secrets without ever showing the stored value', async () => {
    const fetchMock = vi.fn(async () => json(snapshot()))
    vi.stubGlobal('fetch', fetchMock)
    const user = userEvent.setup()
    renderGroup('notifications', snapshot({ 'notify.botToken': { isSet: true, overridden: true } }))
    expect(screen.getByPlaceholderText('Задан')).toBeDisabled()
    await user.click(screen.getByRole('button', { name: 'Очистить' }))
    expect(screen.getByPlaceholderText('Будет очищен')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Сохранить' }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(JSON.parse(String(init.body))).toEqual({ changes: { 'notify.botToken': null } })
  })

  it('shows server-side field errors from a 400', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ error: 'validation', fields: { 'proxy.failThreshold': 'Слишком много' } }, 400)))
    const user = userEvent.setup()
    renderGroup('proxy')
    const input = screen.getByLabelText('Неудач подряд до «dead»')
    await user.clear(input)
    await user.type(input, '7')
    await user.click(screen.getByRole('button', { name: 'Сохранить' }))
    expect(await screen.findByText('Слишком много')).toBeInTheDocument()
  })
})
```

- [ ] **Шаг 3: Убедиться, что тест падает**

```bash
npx vitest run --project web -t SettingsGroupCard
# FAIL: Cannot find module ./settings-group-card
```

- [ ] **Шаг 4: Поле настройки, карточка группы, страница**

- Контрол выбирается по `meta.type`; валидация — та же zod-схема из `@workspace/shared/settings`, что и на сервере.
- Бейджи «изменено»/`effect` и «Сбросить» — **рядом** с меткой, не внутри `<label>` (иначе они попадают в доступное имя поля).
- Секрет: «Задан/Не задан», «Заменить», «Очистить»; значение в браузер не приходит. Пустой секрет во время ввода не подсвечивается ошибкой, но «Сохранить» заблокировано.
- `TabsContent keepMounted` — несохранённые правки не теряются при переключении группы. Группа — в URL (`?group=`).

`apps/web/src/components/settings/draft.ts`

```ts
import { settingsDef, type SettingKey } from '@workspace/shared/settings'

/** Unsaved edit of one setting: a new value, or "remove the override" (PATCH null). */
export type Draft = { kind: 'set'; value: unknown } | { kind: 'reset' }

export function draftError(key: SettingKey, draft: Draft | undefined): string | undefined {
  if (!draft || draft.kind === 'reset') return undefined
  const parsed = settingsDef[key].schema.safeParse(draft.value)
  return parsed.success ? undefined : (parsed.error.issues[0]?.message ?? 'Неверное значение')
}

export function draftsToChanges(drafts: Map<SettingKey, Draft>): Record<string, unknown> {
  const changes: Record<string, unknown> = {}
  for (const [key, draft] of drafts) changes[key] = draft.kind === 'reset' ? null : draft.value
  return changes
}
```

`apps/web/src/components/settings/setting-field.tsx`

```tsx
import * as React from 'react'
import type { SettingStateDto } from '@workspace/shared/api'
import { settingsDef, type SettingKey } from '@workspace/shared/settings'
import { Badge } from '@workspace/ui/components/badge'
import { Button } from '@workspace/ui/components/button'
import { Checkbox } from '@workspace/ui/components/checkbox'
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from '@workspace/ui/components/field'
import { Input } from '@workspace/ui/components/input'
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput, InputGroupText } from '@workspace/ui/components/input-group'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@workspace/ui/components/select'
import { Switch } from '@workspace/ui/components/switch'
import { Textarea } from '@workspace/ui/components/textarea'
import type { Draft } from './draft'

export interface SettingFieldProps {
  settingKey: SettingKey
  state: SettingStateDto
  draft: Draft | undefined
  error: string | undefined
  onDraft: (draft: Draft | undefined) => void
}

const EFFECT_HINT = { immediate: null, new_connections: 'к новым подключениям', restart: 'нужен перезапуск' } as const

/** The value shown in the control: draft → stored value → default. */
function shownValue(key: SettingKey, state: SettingStateDto, draft: Draft | undefined): unknown {
  if (draft?.kind === 'set') return draft.value
  if (draft?.kind === 'reset') return settingsDef[key].default
  return state.value
}

export function SettingField({ settingKey, state, draft, error, onDraft }: SettingFieldProps) {
  const def = settingsDef[settingKey]
  const meta = def.meta
  const id = `setting-${settingKey}`
  const value = shownValue(settingKey, state, draft)
  const nullable = def.default === null
  const overridden = draft ? draft.kind === 'set' : state.overridden
  const effect = EFFECT_HINT[meta.effect]

  const setText = (raw: string) => onDraft(raw === '' && nullable ? { kind: 'reset' } : { kind: 'set', value: raw })
  const setNumber = (raw: string) => onDraft(raw === '' && nullable ? { kind: 'reset' } : { kind: 'set', value: raw === '' ? Number.NaN : Number(raw) })

  let control: React.ReactNode
  switch (meta.type) {
    case 'string':
    case 'duration':
    case 'decimal':
      control = (
        <Input id={id} value={(value as string | null) ?? ''} onChange={(e) => setText(e.target.value)} aria-invalid={error ? true : undefined}
          inputMode={meta.type === 'decimal' ? 'decimal' : undefined} placeholder={meta.type === 'duration' ? 'например 5m' : undefined} />
      )
      break
    case 'text':
      control = <Textarea id={id} value={(value as string | null) ?? ''} onChange={(e) => setText(e.target.value)} aria-invalid={error ? true : undefined} />
      break
    case 'int':
      control = (
        <InputGroup>
          <InputGroupInput id={id} type="number" inputMode="numeric" step={1} value={value === null || Number.isNaN(value) ? '' : String(value)}
            min={meta.min as number | undefined} max={meta.max as number | undefined}
            onChange={(e) => setNumber(e.target.value)} aria-invalid={error ? true : undefined} />
          {meta.unit && (
            <InputGroupAddon align="inline-end">
              <InputGroupText>{meta.unit}</InputGroupText>
            </InputGroupAddon>
          )}
        </InputGroup>
      )
      break
    case 'bool':
      control = <Switch id={id} checked={value === true} onCheckedChange={(checked) => onDraft({ kind: 'set', value: checked })} />
      break
    case 'select': {
      const items = (meta.options ?? []).map((o) => ({ label: o.label, value: o.value }))
      control = (
        <Select items={items} value={value as string} onValueChange={(v) => onDraft({ kind: 'set', value: v })}>
          <SelectTrigger id={id} className="w-full max-w-sm">
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
      break
    }
    case 'multiselect': {
      const selected = new Set((value as string[] | null) ?? [])
      const toggle = (option: string, on: boolean) => {
        const next = (meta.options ?? []).map((o) => o.value).filter((v) => (v === option ? on : selected.has(v)))
        onDraft({ kind: 'set', value: next })
      }
      return (
        <FieldSet data-invalid={error ? true : undefined}>
          <div className="flex flex-wrap items-center gap-2">
            <FieldLegend variant="label">{meta.label}</FieldLegend>
            <StateBadges overridden={overridden} effect={effect} onReset={() => onDraft({ kind: 'reset' })} />
          </div>
          {meta.description && <FieldDescription>{meta.description}</FieldDescription>}
          {(meta.options ?? []).map((option) => (
            <Field key={option.value} orientation="horizontal">
              <Checkbox id={`${id}-${option.value}`} checked={selected.has(option.value)} onCheckedChange={(on) => toggle(option.value, on)} />
              <FieldLabel htmlFor={`${id}-${option.value}`}>{option.label}</FieldLabel>
            </Field>
          ))}
          {error && <FieldError>{error}</FieldError>}
        </FieldSet>
      )
    }
    case 'secret':
      control = <SecretControl id={id} isSet={state.isSet} draft={draft} onDraft={onDraft} invalid={Boolean(error)} />
      break
  }

  const hint = [meta.description, rangeHint(settingKey)].filter(Boolean).join(' ')
  return (
    <Field data-invalid={error ? true : undefined} orientation={meta.type === 'bool' ? 'horizontal' : 'vertical'}>
      <FieldContent>
        <div className="flex flex-wrap items-center gap-2">
          <FieldLabel htmlFor={id}>{meta.label}</FieldLabel>
          <StateBadges overridden={overridden} effect={effect} onReset={() => onDraft({ kind: 'reset' })} />
        </div>
        {hint && <FieldDescription>{hint}</FieldDescription>}
        {meta.type !== 'bool' && control}
        {error && <FieldError>{error}</FieldError>}
      </FieldContent>
      {meta.type === 'bool' && control}
    </Field>
  )
}

function boundsText(min: number | string | undefined, max: number | string | undefined): string {
  if (min !== undefined && max !== undefined) return `от ${min} до ${max}`
  if (min !== undefined) return `не меньше ${min}`
  if (max !== undefined) return `не больше ${max}`
  return ''
}

function rangeHint(key: SettingKey): string {
  const { type, min, max } = settingsDef[key].meta
  const bounds = boundsText(min, max)
  if (type === 'duration') return `Формат: 30s, 5m, 6h, 7d${bounds ? `; ${bounds}` : ''}.`
  if ((type === 'int' || type === 'decimal') && bounds) return `${bounds[0]!.toUpperCase()}${bounds.slice(1)}.`
  return ''
}

function StateBadges({ overridden, effect, onReset }: { overridden: boolean; effect: string | null; onReset: () => void }) {
  return (
    <>
      {effect && <Badge variant="outline">{effect}</Badge>}
      {overridden && (
        <>
          <Badge variant="secondary">изменено</Badge>
          <Button type="button" variant="link" size="xs" onClick={onReset}>
            Сбросить
          </Button>
        </>
      )}
    </>
  )
}

function SecretControl({ id, isSet, draft, onDraft, invalid }: { id: string; isSet: boolean; draft: Draft | undefined; onDraft: (d: Draft | undefined) => void; invalid: boolean }) {
  const editing = draft?.kind === 'set'
  if (editing) {
    return (
      <InputGroup>
        <InputGroupInput id={id} type="password" autoComplete="off" autoFocus value={draft.value as string}
          onChange={(e) => onDraft({ kind: 'set', value: e.target.value })} aria-invalid={invalid ? true : undefined} />
        <InputGroupAddon align="inline-end">
          <InputGroupButton onClick={() => onDraft(undefined)}>Отмена</InputGroupButton>
        </InputGroupAddon>
      </InputGroup>
    )
  }
  const status = draft?.kind === 'reset' ? 'Будет очищен' : isSet ? 'Задан' : 'Не задан'
  return (
    <InputGroup>
      <InputGroupInput id={id} disabled value="" placeholder={status} />
      <InputGroupAddon align="inline-end">
        <InputGroupButton onClick={() => onDraft({ kind: 'set', value: '' })}>{isSet ? 'Заменить' : 'Задать'}</InputGroupButton>
        {isSet && draft?.kind !== 'reset' && <InputGroupButton onClick={() => onDraft({ kind: 'reset' })}>Очистить</InputGroupButton>}
      </InputGroupAddon>
    </InputGroup>
  )
}
```

`apps/web/src/components/settings/settings-group-card.tsx`

```tsx
import * as React from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { SettingsResponse } from '@workspace/shared/api'
import { settingsDef, type SettingGroup, type SettingKey } from '@workspace/shared/settings'
import { Alert, AlertDescription } from '@workspace/ui/components/alert'
import { Button } from '@workspace/ui/components/button'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@workspace/ui/components/card'
import { FieldGroup, FieldSeparator } from '@workspace/ui/components/field'
import { Spinner } from '@workspace/ui/components/spinner'
import { toast } from '@workspace/ui/components/toast'
import { TriangleAlertIcon } from 'lucide-react'
import { api, ApiError } from '@/lib/api'
import { settingsQueryOptions } from '@/lib/settings'
import { draftError, draftsToChanges, type Draft } from './draft'
import { SettingField } from './setting-field'

export function SettingsGroupCard({ group, data }: { group: SettingGroup; data: SettingsResponse }) {
  const queryClient = useQueryClient()
  const keys = React.useMemo(
    () => (Object.keys(settingsDef) as SettingKey[]).filter((k) => settingsDef[k].meta.group === group.id).sort((a, b) => settingsDef[a].meta.order - settingsDef[b].meta.order),
    [group.id],
  )
  const [drafts, setDrafts] = React.useState(() => new Map<SettingKey, Draft>())
  const [serverErrors, setServerErrors] = React.useState<Record<string, string>>({})

  const setDraft = (key: SettingKey, draft: Draft | undefined) => {
    setDrafts((prev) => {
      const next = new Map(prev)
      if (draft) next.set(key, draft)
      else next.delete(key)
      return next
    })
    setServerErrors((prev) => {
      const next = { ...prev }
      delete next[key]
      return next
    })
  }

  const errors = new Map(keys.map((k) => [k, serverErrors[k] ?? draftError(k, drafts.get(k))] as const))
  const invalid = [...errors.values()].some(Boolean)
  const missing = keys.filter((k) => settingsDef[k].meta.required && !data.items[k]?.isSet && drafts.get(k)?.kind !== 'set')

  const save = useMutation({
    mutationFn: () => api<SettingsResponse>('/settings', { method: 'PATCH', json: { changes: draftsToChanges(drafts) } }),
    onSuccess: (response) => {
      queryClient.setQueryData(settingsQueryOptions.queryKey, response)
      setDrafts(new Map())
      toast.add({ title: 'Сохранено', description: group.label })
    },
    onError: (err) => {
      if (err instanceof ApiError && err.status === 400) setServerErrors(err.fields)
      else toast.add({ title: 'Не удалось сохранить', description: err.message })
    },
  })

  return (
    <Card>
      <CardHeader>
        <CardTitle>{group.label}</CardTitle>
        <CardDescription>{group.description}</CardDescription>
      </CardHeader>
      <CardContent>
        <FieldGroup>
          {missing.length > 0 && (
            <Alert>
              <TriangleAlertIcon />
              <AlertDescription>Не заполнено: {missing.map((k) => settingsDef[k].meta.label).join(', ')}.</AlertDescription>
            </Alert>
          )}
          {keys.map((key, i) => {
            const draft = drafts.get(key)
            // an empty secret being typed is not an error yet (Save stays disabled until it is filled)
            const shownError = settingsDef[key].meta.type === 'secret' && draft?.kind === 'set' && draft.value === '' ? undefined : errors.get(key)
            return (
              <React.Fragment key={key}>
                {i > 0 && <FieldSeparator />}
                <SettingField settingKey={key} state={data.items[key]!} draft={draft} error={shownError} onDraft={(d) => setDraft(key, d)} />
              </React.Fragment>
            )
          })}
        </FieldGroup>
      </CardContent>
      <CardFooter className="gap-2">
        <Button disabled={drafts.size === 0 || invalid || save.isPending} onClick={() => save.mutate()}>
          {save.isPending && <Spinner data-icon="inline-start" />}
          Сохранить
        </Button>
        <Button variant="ghost" disabled={drafts.size === 0 || save.isPending} onClick={() => setDrafts(new Map())}>
          Отменить изменения
        </Button>
      </CardFooter>
    </Card>
  )
}
```

`apps/web/src/routes/_authed/settings.tsx`

```tsx
import { useSuspenseQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { settingGroups, type SettingGroupId } from '@workspace/shared/settings'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@workspace/ui/components/tabs'
import { z } from 'zod'
import { PageHeader } from '@/components/page-header'
import { SettingsGroupCard } from '@/components/settings/settings-group-card'
import { settingsQueryOptions } from '@/lib/settings'

const groupIds = settingGroups.map((g) => g.id) as [SettingGroupId, ...SettingGroupId[]]

export const Route = createFileRoute('/_authed/settings')({
  validateSearch: z.object({ group: z.enum(groupIds).optional().catch(undefined) }),
  loader: ({ context }) => context.queryClient.query({ ...settingsQueryOptions, staleTime: 'static' }),
  component: SettingsPage,
})

function SettingsPage() {
  const { group = 'telegram' } = Route.useSearch()
  const navigate = Route.useNavigate()
  const { data } = useSuspenseQuery(settingsQueryOptions)
  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Настройки" description="Применяются сразу, без перезапуска. Секреты хранятся зашифрованными и не показываются." />
      <Tabs value={group} onValueChange={(value) => void navigate({ search: { group: value as SettingGroupId }, replace: true })}>
        <div className="overflow-x-auto">
          <TabsList variant="line">
            {settingGroups.map((g) => (
              <TabsTrigger key={g.id} value={g.id}>
                {g.label}
              </TabsTrigger>
            ))}
          </TabsList>
        </div>
        {settingGroups.map((g) => (
          <TabsContent key={g.id} value={g.id} keepMounted className="pt-4">
            <SettingsGroupCard group={g} data={data} />
          </TabsContent>
        ))}
      </Tabs>
    </div>
  )
}
```

- [ ] **Шаг 5: Тесты, typecheck, lint, сборка**

```bash
npx vitest run --project web   # 8 passed
pnpm --filter web typecheck && pnpm --filter web lint && pnpm --filter web build
```

- [ ] **Шаг 6: Commit**

```bash
git add -A && git commit -m "feat(web): settings page rendered from typed definitions"
```


---

### Задача 17: Web: «Админы» и «Аудит»

**Files:**
- Create: `apps/web/src/lib/{format,admins,audit}.ts`, `apps/web/src/components/data-table.tsx`, `apps/web/src/components/admins/{create-admin-dialog,reset-password-dialog}.tsx`
- Modify: `apps/web/src/routes/_authed/{admins,audit}.tsx` (заглушки → страницы), `packages/ui/src/components/*` (CLI)

**Interfaces:**
- Consumes: `AdminDto`, `AuditPage`, `AuditEntryDto` (6); API задач 10–11; `api`, `PageHeader`, `PasswordInput` (15).
- Produces: `DataTable({ columns, data, pageSize?, empty? })`, `ServerDataTable({ columns, data, rowCount, pagination, onPageChange, empty? })`,
  `clientTableFeatures`/`serverTableFeatures`; `adminsQueryOptions`; `auditQueryOptions(filters)`; `formatDateTime(iso)`.

- [ ] **Шаг 1: Зависимости и компоненты**

```bash
pnpm --filter web add '@tanstack/react-table@^9'
npx shadcn@latest add table skeleton alert-dialog toggle-group -c apps/web -y
```

- [ ] **Шаг 2: Data Table (TanStack Table v9 — как в текущем гайде shadcn)**

`features` — на уровне модуля (стабильная идентичность). Без `columnVisibilityFeature` у строки нет `getVisibleCells()` — используем `getAllCells()`.
Серверная пагинация: `manualPagination` + `rowCount`, состояние страницы — в URL.

`apps/web/src/components/data-table.tsx`

```tsx
import * as React from 'react'
import {
  createPaginatedRowModel,
  rowPaginationFeature,
  tableFeatures,
  useTable,
  type ColumnDef,
  type PaginationState,
  type ReactTable,
  type RowData,
  type TableFeatures,
} from '@tanstack/react-table'
import { Button } from '@workspace/ui/components/button'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@workspace/ui/components/table'

// module scope = stable identity (TanStack Table v9)
export const clientTableFeatures = tableFeatures({ rowPaginationFeature, paginatedRowModel: createPaginatedRowModel() })
export const serverTableFeatures = tableFeatures({ rowPaginationFeature })
export type ClientTableFeatures = typeof clientTableFeatures
export type ServerTableFeatures = typeof serverTableFeatures

interface Pager {
  pageIndex: number
  pageCount: number
  canPrev: boolean
  canNext: boolean
  prev: () => void
  next: () => void
}

function TableShell<TFeatures extends TableFeatures, T extends RowData>(props: {
  table: ReactTable<TFeatures, T>
  columnsCount: number
  empty: React.ReactNode
  pager: Pager
}) {
  const { table } = props
  const rows = table.getRowModel().rows
  return (
    <div className="flex flex-col gap-3">
      <div className="overflow-hidden rounded-lg border">
        <Table>
          <TableHeader>
            {table.getHeaderGroups().map((hg) => (
              <TableRow key={hg.id}>
                {hg.headers.map((header) => (
                  <TableHead key={header.id}>{header.isPlaceholder ? null : <table.FlexRender header={header} />}</TableHead>
                ))}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {rows.length ? (
              rows.map((row) => (
                <TableRow key={row.id}>
                  {row.getAllCells().map((cell) => (
                    <TableCell key={cell.id}>
                      <table.FlexRender cell={cell} />
                    </TableCell>
                  ))}
                </TableRow>
              ))
            ) : (
              <TableRow>
                <TableCell colSpan={props.columnsCount} className="h-24 text-center">
                  {props.empty}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
      {props.pager.pageCount > 1 && (
        <div className="flex items-center justify-end gap-2">
          <span className="text-muted-foreground mr-auto text-sm">
            Страница {props.pager.pageIndex + 1} из {props.pager.pageCount}
          </span>
          <Button variant="outline" size="sm" onClick={props.pager.prev} disabled={!props.pager.canPrev}>
            Назад
          </Button>
          <Button variant="outline" size="sm" onClick={props.pager.next} disabled={!props.pager.canNext}>
            Вперёд
          </Button>
        </div>
      )}
    </div>
  )
}

/** Client-side paginated table on shadcn Table. */
export function DataTable<T extends RowData>(props: {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- heterogeneous column value types
  columns: ColumnDef<ClientTableFeatures, T, any>[]
  data: T[]
  pageSize?: number
  empty?: React.ReactNode
}) {
  const [pagination, setPagination] = React.useState<PaginationState>({ pageIndex: 0, pageSize: props.pageSize ?? 20 })
  const table = useTable({
    features: clientTableFeatures,
    columns: props.columns,
    data: props.data,
    state: { pagination },
    onPaginationChange: setPagination,
  })
  return (
    <TableShell
      table={table}
      columnsCount={props.columns.length}
      empty={props.empty ?? 'Нет данных'}
      pager={{
        pageIndex: table.state.pagination.pageIndex,
        pageCount: table.getPageCount(),
        canPrev: table.getCanPreviousPage(),
        canNext: table.getCanNextPage(),
        prev: () => table.previousPage(),
        next: () => table.nextPage(),
      }}
    />
  )
}

/** Server-side paginated table: rows arrive already paginated; page state lives in the URL. */
export function ServerDataTable<T extends RowData>(props: {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- heterogeneous column value types
  columns: ColumnDef<ServerTableFeatures, T, any>[]
  data: T[]
  rowCount: number
  pagination: PaginationState
  onPageChange: (pageIndex: number) => void
  empty?: React.ReactNode
}) {
  const table = useTable({
    features: serverTableFeatures,
    columns: props.columns,
    data: props.data,
    manualPagination: true,
    rowCount: props.rowCount,
    state: { pagination: props.pagination },
    onPaginationChange: (updater) => {
      const next = typeof updater === 'function' ? updater(props.pagination) : updater
      props.onPageChange(next.pageIndex)
    },
  })
  return (
    <TableShell
      table={table}
      columnsCount={props.columns.length}
      empty={props.empty ?? 'Нет данных'}
      pager={{
        pageIndex: props.pagination.pageIndex,
        pageCount: table.getPageCount(),
        canPrev: table.getCanPreviousPage(),
        canNext: table.getCanNextPage(),
        prev: () => table.previousPage(),
        next: () => table.nextPage(),
      }}
    />
  )
}
```

- [ ] **Шаг 3: Запросы и формат дат**

`apps/web/src/lib/format.ts`

```ts
const dateTime = new Intl.DateTimeFormat('ru-RU', { dateStyle: 'short', timeStyle: 'medium' })

export function formatDateTime(iso: string | null | undefined): string {
  return iso ? dateTime.format(new Date(iso)) : '—'
}
```

`apps/web/src/lib/admins.ts`

```ts
import { queryOptions } from '@tanstack/react-query'
import type { AdminDto } from '@workspace/shared/api'
import { api } from './api'

export const adminsQueryOptions = queryOptions({
  queryKey: ['admins'] as const,
  queryFn: ({ signal }) => api<{ items: AdminDto[] }>('/admins', { signal }),
})
```

`apps/web/src/lib/audit.ts`

```ts
import { keepPreviousData, queryOptions } from '@tanstack/react-query'
import type { AuditPage } from '@workspace/shared/api'
import { api } from './api'

export type AuditPeriod = '24h' | '7d' | '30d' | 'all'
export interface AuditFilters {
  page: number
  pageSize: number
  action?: string
  adminId?: string
  period: AuditPeriod
}

const PERIOD_MS: Record<Exclude<AuditPeriod, 'all'>, number> = { '24h': 86_400_000, '7d': 7 * 86_400_000, '30d': 30 * 86_400_000 }

export const auditQueryOptions = (f: AuditFilters) =>
  queryOptions({
    queryKey: ['audit', f] as const,
    queryFn: ({ signal }) => {
      const qs = new URLSearchParams({ page: String(f.page), pageSize: String(f.pageSize) })
      if (f.action) qs.set('action', f.action)
      if (f.adminId) qs.set('adminId', f.adminId)
      if (f.period !== 'all') qs.set('from', new Date(Date.now() - PERIOD_MS[f.period]).toISOString())
      return api<AuditPage>(`/audit?${qs}`, { signal })
    },
    placeholderData: keepPreviousData,
  })
```

- [ ] **Шаг 4: Страница «Админы»**

`apps/web/src/components/admins/create-admin-dialog.tsx`

```tsx
import * as React from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Button } from '@workspace/ui/components/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@workspace/ui/components/dialog'
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from '@workspace/ui/components/field'
import { Input } from '@workspace/ui/components/input'
import { Spinner } from '@workspace/ui/components/spinner'
import { toast } from '@workspace/ui/components/toast'
import { PlusIcon } from 'lucide-react'
import { PasswordInput } from '@/components/password-input'
import { adminsQueryOptions } from '@/lib/admins'
import { api, ApiError } from '@/lib/api'

export function CreateAdminDialog() {
  const queryClient = useQueryClient()
  const [open, setOpen] = React.useState(false)
  const [login, setLogin] = React.useState('')
  const [password, setPassword] = React.useState('')
  const mutation = useMutation({
    mutationFn: () => api('/admins', { method: 'POST', json: { login, password } }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: adminsQueryOptions.queryKey })
      toast.add({ title: 'Админ создан', description: login })
      setOpen(false)
      setLogin('')
      setPassword('')
      mutation.reset()
    },
  })
  const err = mutation.error instanceof ApiError ? mutation.error : null
  const fields = err?.fields ?? {}
  const loginError = fields.login ?? (err?.status === 409 ? err.message : undefined)

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button />}>
        <PlusIcon data-icon="inline-start" />
        Добавить админа
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
            <DialogTitle>Новый админ</DialogTitle>
            <DialogDescription>У всех админов одинаковые полные права.</DialogDescription>
          </DialogHeader>
          <FieldGroup>
            <Field data-invalid={loginError ? true : undefined}>
              <FieldLabel htmlFor="new-admin-login">Логин</FieldLabel>
              <Input id="new-admin-login" required autoComplete="off" value={login} onChange={(e) => setLogin(e.target.value)} aria-invalid={loginError ? true : undefined} />
              <FieldDescription>3–32 символа: латиница, цифры, точка, дефис, подчёркивание.</FieldDescription>
              {loginError && <FieldError>{loginError}</FieldError>}
            </Field>
            <Field data-invalid={fields.password ? true : undefined}>
              <FieldLabel htmlFor="new-admin-password">Пароль</FieldLabel>
              <PasswordInput id="new-admin-password" required minLength={10} autoComplete="new-password" value={password}
                onChange={(e) => setPassword(e.target.value)} aria-invalid={fields.password ? true : undefined} />
              {fields.password && <FieldError>{fields.password}</FieldError>}
            </Field>
          </FieldGroup>
          <DialogFooter>
            <Button type="submit" disabled={mutation.isPending}>
              {mutation.isPending && <Spinner data-icon="inline-start" />}
              Создать
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
```

`apps/web/src/components/admins/reset-password-dialog.tsx`

```tsx
import * as React from 'react'
import { useMutation } from '@tanstack/react-query'
import type { AdminDto } from '@workspace/shared/api'
import { Button } from '@workspace/ui/components/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@workspace/ui/components/dialog'
import { Field, FieldError, FieldGroup, FieldLabel } from '@workspace/ui/components/field'
import { Spinner } from '@workspace/ui/components/spinner'
import { toast } from '@workspace/ui/components/toast'
import { PasswordInput } from '@/components/password-input'
import { api, ApiError } from '@/lib/api'

export function ResetPasswordDialog({ admin, onOpenChange }: { admin: AdminDto | null; onOpenChange: (open: boolean) => void }) {
  const [password, setPassword] = React.useState('')
  const mutation = useMutation({
    mutationFn: (id: string) => api(`/admins/${id}/reset-password`, { method: 'POST', json: { password } }),
    onSuccess: () => {
      toast.add({ title: 'Пароль сброшен', description: `${admin?.login}: все его сессии завершены.` })
      onOpenChange(false)
      setPassword('')
    },
  })
  const error = mutation.error instanceof ApiError ? (mutation.error.fields.password ?? mutation.error.message) : undefined
  return (
    <Dialog open={admin !== null} onOpenChange={onOpenChange}>
      <DialogContent>
        <form
          className="flex flex-col gap-6"
          onSubmit={(e) => {
            e.preventDefault()
            if (admin) mutation.mutate(admin.id)
          }}
        >
          <DialogHeader>
            <DialogTitle>Сбросить пароль: {admin?.login}</DialogTitle>
            <DialogDescription>Все активные сессии этого админа будут завершены.</DialogDescription>
          </DialogHeader>
          <FieldGroup>
            <Field data-invalid={error ? true : undefined}>
              <FieldLabel htmlFor="reset-password">Новый пароль</FieldLabel>
              <PasswordInput id="reset-password" required minLength={10} autoComplete="new-password" value={password}
                onChange={(e) => setPassword(e.target.value)} aria-invalid={error ? true : undefined} />
              {error && <FieldError>{error}</FieldError>}
            </Field>
          </FieldGroup>
          <DialogFooter>
            <Button type="submit" disabled={mutation.isPending}>
              {mutation.isPending && <Spinner data-icon="inline-start" />}
              Сбросить
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
```

`apps/web/src/routes/_authed/admins.tsx`

```tsx
import * as React from 'react'
import { useMutation, useQueryClient, useSuspenseQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { createColumnHelper } from '@tanstack/react-table'
import type { AdminDto } from '@workspace/shared/api'
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
import { toast } from '@workspace/ui/components/toast'
import { MoreHorizontalIcon } from 'lucide-react'
import { CreateAdminDialog } from '@/components/admins/create-admin-dialog'
import { ResetPasswordDialog } from '@/components/admins/reset-password-dialog'
import { DataTable, type ClientTableFeatures } from '@/components/data-table'
import { PageHeader } from '@/components/page-header'
import { adminsQueryOptions } from '@/lib/admins'
import { api, ApiError } from '@/lib/api'
import { formatDateTime } from '@/lib/format'

export const Route = createFileRoute('/_authed/admins')({
  loader: ({ context }) => context.queryClient.query({ ...adminsQueryOptions, staleTime: 'static' }),
  component: AdminsPage,
})

const col = createColumnHelper<ClientTableFeatures, AdminDto>()

function AdminsPage() {
  const { me } = Route.useRouteContext()
  const queryClient = useQueryClient()
  const { data } = useSuspenseQuery(adminsQueryOptions)
  const [resetTarget, setResetTarget] = React.useState<AdminDto | null>(null)
  const [disableTarget, setDisableTarget] = React.useState<AdminDto | null>(null)

  const disable = useMutation({
    mutationFn: (id: string) => api(`/admins/${id}/disable`, { method: 'POST' }),
    onSuccess: () => toast.add({ title: 'Админ отключён', description: disableTarget?.login }),
    onError: (err) => toast.add({ title: 'Не удалось отключить', description: err instanceof ApiError ? err.message : String(err) }),
    onSettled: async () => {
      setDisableTarget(null)
      await queryClient.invalidateQueries({ queryKey: adminsQueryOptions.queryKey })
    },
  })

  const columns = React.useMemo(
    () =>
      col.columns([
        col.accessor('login', {
          header: 'Логин',
          cell: (info) => (
            <span className="flex items-center gap-2">
              {info.getValue()}
              {info.row.original.id === me.id && <Badge variant="outline">вы</Badge>}
            </span>
          ),
        }),
        col.accessor('disabledAt', {
          header: 'Статус',
          cell: (info) => (info.getValue() ? <Badge variant="destructive">отключён</Badge> : <Badge variant="secondary">активен</Badge>),
        }),
        col.accessor('lastLoginAt', { header: 'Последний вход', cell: (info) => formatDateTime(info.getValue()) }),
        col.accessor('createdAt', { header: 'Создан', cell: (info) => formatDateTime(info.getValue()) }),
        col.display({
          id: 'actions',
          header: () => <span className="sr-only">Действия</span>,
          cell: ({ row }) =>
            row.original.disabledAt ? null : (
              <DropdownMenu>
                <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label={`Действия: ${row.original.login}`} />}>
                  <MoreHorizontalIcon />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuGroup>
                    <DropdownMenuItem onClick={() => setResetTarget(row.original)}>Сбросить пароль</DropdownMenuItem>
                    <DropdownMenuItem variant="destructive" onClick={() => setDisableTarget(row.original)}>
                      Отключить
                    </DropdownMenuItem>
                  </DropdownMenuGroup>
                </DropdownMenuContent>
              </DropdownMenu>
            ),
        }),
      ]),
    [me.id],
  )

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Админы" description="Все админы равны по правам. Действия записываются в аудит." actions={<CreateAdminDialog />} />
      <DataTable columns={columns} data={data.items} />
      <ResetPasswordDialog admin={resetTarget} onOpenChange={(open) => !open && setResetTarget(null)} />
      <AlertDialog open={disableTarget !== null} onOpenChange={(open) => !open && setDisableTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Отключить {disableTarget?.login}?</AlertDialogTitle>
            <AlertDialogDescription>Админ не сможет войти, его активные сессии будут завершены.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Отмена</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => disableTarget && disable.mutate(disableTarget.id)}>
              Отключить
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
```

- [ ] **Шаг 5: Страница «Аудит»: период (ToggleGroup), админ (Select), действие (Input), детали (Dialog)**

`stripSearchParams(defaults)` — значения по умолчанию не пишутся в URL.

`apps/web/src/routes/_authed/audit.tsx`

```tsx
import * as React from 'react'
import { useQuery } from '@tanstack/react-query'
import { createFileRoute, stripSearchParams } from '@tanstack/react-router'
import { createColumnHelper } from '@tanstack/react-table'
import type { AuditEntryDto } from '@workspace/shared/api'
import { Badge } from '@workspace/ui/components/badge'
import { Button } from '@workspace/ui/components/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@workspace/ui/components/dialog'
import { Field, FieldLabel } from '@workspace/ui/components/field'
import { Input } from '@workspace/ui/components/input'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@workspace/ui/components/select'
import { Skeleton } from '@workspace/ui/components/skeleton'
import { ToggleGroup, ToggleGroupItem } from '@workspace/ui/components/toggle-group'
import { z } from 'zod'
import { ServerDataTable, type ServerTableFeatures } from '@/components/data-table'
import { PageHeader } from '@/components/page-header'
import { adminsQueryOptions } from '@/lib/admins'
import { auditQueryOptions, type AuditPeriod } from '@/lib/audit'
import { formatDateTime } from '@/lib/format'

const defaults = { page: 1, period: '7d' as AuditPeriod }
const auditSearch = z.object({
  page: z.number().int().min(1).default(defaults.page).catch(defaults.page),
  period: z.enum(['24h', '7d', '30d', 'all']).default(defaults.period).catch(defaults.period),
  action: z.string().max(100).optional().catch(undefined),
  adminId: z.uuid().optional().catch(undefined),
})

export const Route = createFileRoute('/_authed/audit')({
  validateSearch: auditSearch,
  search: { middlewares: [stripSearchParams(defaults)] },
  component: AuditPage,
})

const PAGE_SIZE = 50
const col = createColumnHelper<ServerTableFeatures, AuditEntryDto>()

function actorLabel(e: AuditEntryDto): string {
  if (e.actorType === 'cli') return 'CLI'
  if (e.actorType === 'system') return 'система'
  return e.adminLogin ?? 'аноним'
}

function AuditPage() {
  const search = Route.useSearch()
  const navigate = Route.useNavigate()
  const [details, setDetails] = React.useState<AuditEntryDto | null>(null)
  const [actionDraft, setActionDraft] = React.useState(search.action ?? '')
  const admins = useQuery(adminsQueryOptions)
  const { data, isPending } = useQuery(auditQueryOptions({ ...search, pageSize: PAGE_SIZE }))

  const columns = React.useMemo(
    () =>
      col.columns([
        col.accessor('createdAt', { header: 'Время', cell: (i) => <span className="whitespace-nowrap">{formatDateTime(i.getValue())}</span> }),
        col.display({ id: 'actor', header: 'Кто', cell: ({ row }) => actorLabel(row.original) }),
        col.accessor('action', { header: 'Действие', cell: (i) => <Badge variant="outline">{i.getValue()}</Badge> }),
        col.display({
          id: 'target',
          header: 'Объект',
          cell: ({ row }) => (row.original.targetType ? `${row.original.targetType}:${row.original.targetId?.slice(0, 8) ?? ''}` : '—'),
        }),
        col.accessor('result', {
          header: 'Результат',
          cell: (i) => (
            <Badge variant={i.getValue() === 'ok' ? 'secondary' : 'destructive'}>
              {i.getValue() === 'ok' ? 'ок' : 'ошибка'} {i.row.original.statusCode ?? ''}
            </Badge>
          ),
        }),
        col.accessor('ip', { header: 'IP', cell: (i) => i.getValue() ?? '—' }),
        col.display({
          id: 'details',
          header: () => <span className="sr-only">Подробнее</span>,
          cell: ({ row }) => (
            <Button variant="ghost" size="sm" onClick={() => setDetails(row.original)}>
              Подробнее
            </Button>
          ),
        }),
      ]),
    [],
  )

  const adminItems = [{ label: 'Все', value: null as string | null }, ...(admins.data?.items ?? []).map((a) => ({ label: a.login, value: a.id }))]
  const setSearch = (patch: Partial<typeof search>) => void navigate({ search: (prev) => ({ ...prev, page: 1, ...patch }) })

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Аудит" description="Все изменяющие действия админов, CLI и системы." />
      <div className="flex flex-wrap items-end gap-4">
        <Field className="w-auto">
          <FieldLabel>Период</FieldLabel>
          <ToggleGroup variant="outline" value={[search.period]} onValueChange={(v) => v[0] && setSearch({ period: v[0] as AuditPeriod })}>
            <ToggleGroupItem value="24h">24 часа</ToggleGroupItem>
            <ToggleGroupItem value="7d">7 дней</ToggleGroupItem>
            <ToggleGroupItem value="30d">30 дней</ToggleGroupItem>
            <ToggleGroupItem value="all">Всё время</ToggleGroupItem>
          </ToggleGroup>
        </Field>
        <Field className="w-48">
          <FieldLabel htmlFor="audit-admin">Админ</FieldLabel>
          <Select items={adminItems} value={search.adminId ?? null} onValueChange={(v) => setSearch({ adminId: v ?? undefined })}>
            <SelectTrigger id="audit-admin" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {adminItems.map((item) => (
                  <SelectItem key={item.label} value={item.value}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </Field>
        <form
          className="contents"
          onSubmit={(e) => {
            e.preventDefault()
            setSearch({ action: actionDraft.trim() || undefined })
          }}
        >
          <Field className="w-64">
            <FieldLabel htmlFor="audit-action">Действие</FieldLabel>
            <Input id="audit-action" placeholder="например settings.update" value={actionDraft} onChange={(e) => setActionDraft(e.target.value)}
              onBlur={() => setSearch({ action: actionDraft.trim() || undefined })} />
          </Field>
        </form>
      </div>
      {isPending ? (
        <Skeleton className="h-64 w-full" />
      ) : (
        <ServerDataTable
          columns={columns}
          data={data?.items ?? []}
          rowCount={data?.total ?? 0}
          pagination={{ pageIndex: search.page - 1, pageSize: PAGE_SIZE }}
          onPageChange={(pageIndex) => void navigate({ search: (prev) => ({ ...prev, page: pageIndex + 1 }) })}
          empty="Записей нет"
        />
      )}
      <Dialog open={details !== null} onOpenChange={(open) => !open && setDetails(null)}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{details?.action}</DialogTitle>
            <DialogDescription>
              {details && `${formatDateTime(details.createdAt)} · ${actorLabel(details)} · ${details.ip ?? '—'} · ${details.durationMs ?? '—'} мс`}
            </DialogDescription>
          </DialogHeader>
          <pre className="bg-muted max-h-96 overflow-auto rounded-lg p-3 text-xs">{JSON.stringify(details?.payload ?? null, null, 2)}</pre>
          {details?.userAgent && <p className="text-muted-foreground text-xs break-all">{details.userAgent}</p>}
        </DialogContent>
      </Dialog>
    </div>
  )
}
```

- [ ] **Шаг 6: Typecheck, lint, сборка, ручная проверка**

```bash
pnpm --filter web typecheck && pnpm --filter web lint && pnpm --filter web build && npx vitest run
pnpm dev   # «Админы»: создать → «Действия» → «Отключить» → статус «отключён»; «Аудит»: записи admin.create/admin.disable, «Подробнее»
```

Автоматически эти сценарии покрывает e2e в задаче 18.

- [ ] **Шаг 7: Commit**

```bash
git add -A && git commit -m "feat(web): admins and audit pages on data tables"
```


---

### Задача 18: E2E-smoke и CI

**Files:**
- Create: `playwright.config.ts`, `e2e/{fixtures.ts,smoke.spec.ts,tsconfig.json}`, `.github/workflows/ci.yml`
- Modify: корневой `package.json` (`@playwright/test`)

**Interfaces:**
- Consumes: весь стек задач 1–17. Переменные: `E2E_BASE_URL`, `E2E_LOGIN`, `E2E_PASSWORD`.

- [ ] **Шаг 1: Playwright**

```bash
pnpm add -w -D '@playwright/test@^1'
pnpm exec playwright install chromium
```

`playwright.config.ts`

```ts
import { defineConfig, devices } from '@playwright/test'

// Runs against a running stack (docker compose in CI, or the dev server locally):
//   E2E_BASE_URL=http://localhost:3000 E2E_LOGIN=e2e E2E_PASSWORD=... pnpm e2e
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: { baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:3000', trace: 'on-first-retry' },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile', use: { ...devices['Pixel 7'] } },
  ],
})
```

`e2e/fixtures.ts`

```ts
import { expect, type Page } from '@playwright/test'

export const LOGIN = process.env.E2E_LOGIN ?? 'e2e'
export const PASSWORD = process.env.E2E_PASSWORD ?? 'e2e-password-123'

export async function signIn(page: Page): Promise<void> {
  await page.goto('/')
  await expect(page).toHaveURL(/\/login/)
  await page.getByLabel('Логин').fill(LOGIN)
  await page.getByLabel('Пароль', { exact: true }).fill(PASSWORD)
  await page.getByRole('button', { name: 'Войти' }).click()
  await expect(page.getByRole('heading', { name: 'Коды' })).toBeVisible()
}

/** Desktop shows tabs in the header; mobile hides them behind the menu Sheet. */
export async function goToSection(page: Page, name: string, isMobile: boolean): Promise<void> {
  if (isMobile) await page.getByRole('button', { name: 'Открыть меню' }).click()
  await page.getByRole('tab', { name }).click()
  await expect(page.getByRole('heading', { name })).toBeVisible()
}
```

`e2e/smoke.spec.ts`

```ts
import { expect, test } from '@playwright/test'
import { goToSection, LOGIN, signIn } from './fixtures'

test('wrong password shows an error and stays on /login', async ({ page }) => {
  await page.goto('/login')
  await page.getByLabel('Логин').fill(LOGIN)
  await page.getByLabel('Пароль', { exact: true }).fill('definitely-wrong')
  await page.getByRole('button', { name: 'Войти' }).click()
  await expect(page.getByText('Неверный логин или пароль')).toBeVisible()
  await expect(page).toHaveURL(/\/login/)
})

test('deep link survives the login redirect', async ({ page }) => {
  await page.goto('/audit')
  await expect(page).toHaveURL(/\/login\?redirect=%2Faudit/)
})

test('navigates between sections', async ({ page, isMobile }) => {
  await signIn(page)
  for (const section of ['Аудит', 'Админы', 'Настройки', 'Коды']) await goToSection(page, section, isMobile)
})

test('saves a setting, keeps it after reload, resets it back', async ({ page, isMobile }) => {
  await signIn(page)
  await goToSection(page, 'Настройки', isMobile)
  await page.getByRole('tab', { name: 'Хранение' }).click()
  const panel = page.getByRole('tabpanel', { name: 'Хранение' })
  const input = panel.getByLabel('Хранить коды')
  await input.fill('45')
  await panel.getByRole('button', { name: 'Сохранить' }).click()
  await expect(page.getByText('Сохранено').first()).toBeVisible()
  await page.reload()
  await expect(page.getByRole('tabpanel', { name: 'Хранение' }).getByLabel('Хранить коды')).toHaveValue('45')
  const reloaded = page.getByRole('tabpanel', { name: 'Хранение' })
  await reloaded.getByRole('button', { name: 'Сбросить' }).click()
  await reloaded.getByRole('button', { name: 'Сохранить' }).click()
  await expect(reloaded.getByLabel('Хранить коды')).toHaveValue('30')
})

test('logout returns to the login page', async ({ page }) => {
  await signIn(page)
  await page.getByRole('button', { name: 'Меню пользователя' }).click()
  await page.getByRole('menuitem', { name: 'Выйти' }).click()
  await expect(page).toHaveURL(/\/login/)
  await page.goto('/')
  await expect(page).toHaveURL(/\/login/)
})

test('creates an admin, then disables it', async ({ page, isMobile }) => {
  const login = `e2e${Date.now().toString(36)}`
  await signIn(page)
  await goToSection(page, 'Админы', isMobile)
  await page.getByRole('button', { name: 'Добавить админа' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('Логин').fill(login)
  await dialog.getByLabel('Пароль', { exact: true }).fill('long-enough-password')
  await dialog.getByRole('button', { name: 'Создать' }).click()
  const row = page.getByRole('row').filter({ hasText: login })
  await expect(row).toContainText('активен')
  await row.getByRole('button', { name: `Действия: ${login}` }).click()
  await page.getByRole('menuitem', { name: 'Отключить' }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: 'Отключить' }).click()
  await expect(row).toContainText('отключён')
})
```

`e2e/tsconfig.json`

```json
{
  "extends": "../tsconfig.node.json",
  "compilerOptions": { "module": "ESNext", "moduleResolution": "Bundler" },
  "include": ["**/*.ts", "../playwright.config.ts"]
}
```

- [ ] **Шаг 2: Прогнать e2e против compose-стека**

```bash
docker compose up -d --build --wait
printf 'e2e-password-123\n' | docker compose exec -T accs-api node apps/api/src/cli.ts admin:create --login e2e --password-stdin
E2E_BASE_URL=http://localhost:3000 pnpm e2e   # 12 passed (desktop + Pixel 7)
npx tsc -p e2e/tsconfig.json
docker compose down
```

- [ ] **Шаг 3: CI**

`checks`: lint → typecheck → тесты (Postgres/Redis — сервисы GitHub Actions, testcontainers не запускается). `e2e`: сборка compose, админ через CLI, Playwright; при падении — отчёт и логи compose.

`.github/workflows/ci.yml`

```yaml
name: ci

on:
  push:
    branches: [main]
  pull_request:

concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: true

jobs:
  checks:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:18-trixie
        env:
          POSTGRES_USER: test
          POSTGRES_PASSWORD: test
          POSTGRES_DB: test
        ports: ["5432:5432"]
        options: >-
          --health-cmd "pg_isready -U test -d test"
          --health-interval 5s --health-timeout 3s --health-retries 30
      redis:
        image: redis:8-trixie
        ports: ["6379:6379"]
        options: >-
          --health-cmd "redis-cli ping"
          --health-interval 5s --health-timeout 3s --health-retries 30
    env:
      # vitest.global-setup.ts uses these instead of starting testcontainers
      TEST_PG_URL: postgres://test:test@localhost:5432/test
      TEST_REDIS_URL: redis://localhost:6379
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-node@v7
        with:
          node-version: 26
      - run: npm i -g pnpm@12.8.2
      - run: pnpm install --frozen-lockfile
      - run: pnpm lint
      - run: pnpm typecheck
      - run: pnpm test

  e2e:
    runs-on: ubuntu-latest
    needs: checks
    env:
      E2E_BASE_URL: http://localhost:3000
      E2E_LOGIN: e2e
      E2E_PASSWORD: e2e-password-123
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-node@v7
        with:
          node-version: 26
      - run: npm i -g pnpm@12.8.2
      - run: pnpm install --frozen-lockfile
      - name: Write .env for compose
        run: |
          {
            echo "POSTGRES_PASSWORD=ci-$(openssl rand -hex 12)"
            echo "APP_ENCRYPTION_KEY=$(openssl rand -base64 32)"
            echo "PUBLIC_ORIGIN=$E2E_BASE_URL"
          } > .env
      - run: docker compose up -d --build --wait
      - name: Create e2e admin
        run: printf '%s\n' "$E2E_PASSWORD" | docker compose exec -T accs-api node apps/api/src/cli.ts admin:create --login "$E2E_LOGIN" --password-stdin
      - run: pnpm exec playwright install --with-deps chromium
      - run: pnpm e2e
      - name: Collect logs
        if: failure()
        run: docker compose logs --no-color > compose.log
      - uses: actions/upload-artifact@v7
        if: failure()
        with:
          name: e2e-report
          path: |
            playwright-report
            compose.log
```

```bash
docker run --rm -v "$PWD:/repo" -w /repo rhysd/actionlint:latest   # без вывода = ок
```

- [ ] **Шаг 4: Commit**

```bash
git add -A && git commit -m "ci: lint, typecheck, tests with services; e2e smoke on compose stack"
```


---

## После плана 1

- План 2 (пул прокси, воркер с advisory lock, BullMQ) и план 3 (Telegram-аккаунты) пишутся перед своей реализацией, с учётом того, что выяснится здесь.
- Открытые вопросы спеки §13 (шифрование ключа в хранилище mtcute, признаки заморозки, http vs socks у proxy-store, «живая» tdata 7.x) закрываются спайками в начале плана 3 / плана 2.
