# План 3 — Вход по номеру и облачный пароль: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Дать два новых сценария.
- Добавлять аккаунт новой сессией со своим api_id по номеру телефона (код приходит в Telegram Desktop), с облачным паролем.
- Управлять облачным паролем добавленных аккаунтов: состояние, показ сохранённого, «указать текущий», установка и смена с почтой восстановления.

**Architecture:**
- **Вход по номеру** — поток в воркере по образцу QR. Код, пароль, «ещё раз» и отмена приходят через приватный Redis-канал входа, прогресс уходит событием `phone.update`.
- **Общий модуль.** QR и номер завершаются в `login/common.ts`: дубликат отклоняется, аккаунт сохраняется с сессией и паролем, клиент входа уничтожается до старта аккаунта.
- **Облачный пароль** — команды воркеру с ответом (`account.password.*`). Секреты в них только зашифрованы, пароль хранится в `accounts.cloud_password_enc`, пишет его только воркер после подтверждения Telegram.
- **Состояние 2FA** не хранится: его спрашивают у Telegram при открытии карточки.

**Tech Stack:** как в плане 2 (mtcute 0.32.3, BullMQ 6, Hono, Drizzle, React 19 + TanStack, shadcn на Base UI). Новых зависимостей нет.

**Spec:** `docs/superpowers/specs/2026-10-03-phone-login-cloud-password-design.md`, дополняет `docs/superpowers/specs/2026-10-03-accs-manager-design.md`.

**Как получен код:** весь код плана написан и прогнан в песочнице, по задаче на коммит. Каждая задача прошла гейт: typecheck, lint, тесты.
- **Итог:** 330 тестов vitest (shared/db/server/api/web/worker) и 20 e2e (desktop + Pixel 7).
- **Живая проверка** на Telegram — задача 10.

## Global Constraints

- **Всё из Global Constraints плана 2 в силе.** Node 26 через `fnm exec --using=26`, pnpm 12.8.2, тексты UI на русском, shadcn по скиллу. Drizzle-операторы — из `@workspace/db`. Локальные коммиты, **без `git push`** до решения владельца.
- **Облачный пароль хранится только зашифрованным** `APP_ENCRYPTION_KEY` (решение владельца). Показывается в карточке по кнопке, показ пишется в аудит.
- **Код входа, облачные пароли и код из письма:**
  - во входе по номеру идут через Redis pub/sub `accs:login:<id>`;
  - в командах `account.password.*` — только полями `…Enc` (шифротекст);
  - в аудит не попадают (`payload: null`) и в логи тоже.
- **Если аккаунт уже есть в панели**, вход по номеру отказывает, как QR: новая сессия сразу выходит (решение владельца).
- **Почта восстановления — необязательный шаг** («Пропустить»). Привязанная почта видна в карточке.
- **«Напрямую»** — только явным выбором админа, как во всей панели.
- **Регистрацию новых номеров, снятие облачного пароля и отмену отложенного сброса не делаем** (вне объёма спеки).

## Уточнения к спеке, принятые в плане

1. **«Живые» данные аккаунта.** Состояние облачного пароля, как и сессии, не перезапрашивается на каждое событие `accounts.changed` / `code.new` (`ON_DEMAND_ACCOUNT_QUERIES`). Иначе каждый новый код дёргал бы Telegram.
2. **Неподтверждённая почта.** Если почта восстановления ждёт кода, в карточке есть кнопка «Ввести код из письма». Тот же диалог, что и после установки.
3. **Подсказка.** При смене пароля пустая подсказка снимает старую: Telegram хранит подсказку вместе с паролем.
4. **Маршрут пароля входа по номеру** использует ту же схему, что и QR (`qrPasswordInput`: 1–256 символов).

## Review Focus

Режимы отказа, которые спека подразумевает, но прямо не проговаривает. Каждый закреплён тестом в задаче-владельце.

1. **Код пришёл не в Desktop, а по SMS или звонком, или админ просит «ещё раз» раньше срока.**
   - Ожидание: панель говорит, куда ушёл код; кнопка повтора подписана следующим способом и включается только после отсчёта Telegram.
   - Тесты — задача 3 «sends the code again by the next method…», задача 7 «lets the code be sent again once Telegram allows it…».
2. **Пароль сменили вне панели.**
   - Ожидание: сохранённый пароль забывается, а не показывается устаревшим. Смена просит текущий с понятным сообщением.
   - Тесты — задача 5 «forgets a stored password Telegram no longer accepts», «needs the current password when the panel does not know it…».
3. **Секреты в очереди и аудите.**
   - Ожидание: ни код, ни пароли не лежат открытым текстом ни в задачах BullMQ, ни в `audit_log`.
   - Тесты — задача 4 (аудит), задача 6 «sends passwords and codes to the worker only encrypted, and never into the audit log».
4. **Свежая сессия (`SESSION_TOO_FRESH`).** Это как раз аккаунты, только что добавленные по номеру или QR.
   - Ожидание: «подождите N ч», а не непонятная ошибка.
   - Тесты — задача 5 «reports how long Telegram makes a fresh session wait», задача 6 «turns what the worker refused into words».
5. **Вход по номеру в аккаунт, который уже в панели.**
   - Ожидание: отказ, новая сессия выходит, лишнего устройства у владельца не остаётся.
   - Тест — задача 3 «refuses an account that is already in the panel and logs the new session out».

## Перед началом

- **Локальная dev-БД:** после задачи 1 — `pnpm --filter @workspace/db db:migrate`, чтобы появилась колонка `cloud_password_enc`. Иначе страница «Аккаунты» в dev падает.
- **Миграция `0003`:** `drizzle-kit generate` может написать «Please install latest version of drizzle-orm» — см. AGENTS.md про скрытый hoist pnpm. Ожидаемый SQL приведён в задаче 1.
- **Один auth key — одно место:** живая проверка (задача 10) — на аккаунте, которого нет в других местах.

## Файловая структура

```
packages/shared/src/{accounts,commands,events}.ts, settings/definitions.ts   # контракты, подпись qrTimeout
packages/db/src/schema.ts, drizzle/0003_cloud_password.sql                    # accounts.cloud_password_enc
apps/worker/src/login/{common,phone,phone-client,profile}.ts                  # общее для входов; вход по номеру
apps/worker/src/qr/{login,client}.ts                                          # QR на общем модуле
apps/worker/src/accounts/cloud-password.ts, accounts/manager.ts (runningSession)
apps/worker/src/telegram/{session,mtcute-session}.ts                          # методы 2FA
apps/api/src/routes/{phone-login,cloud-password}.ts
apps/web/src/components/accounts/{phone-login-tab,cloud-password-card,cloud-password-dialogs}.tsx
apps/web/src/lib/accounts.ts, routes/_authed.tsx, routes/_authed/accounts/{index,$id}.tsx
e2e/telegram.spec.ts · AGENTS.md
```

## Задачи

| # | Задача | Результат |
|---|---|---|
| 1 | Контракты: вход по номеру и облачный пароль; поле в БД | схемы, команды, событие `phone.update`, миграция `0003` |
| 2 | Воркер: общий модуль завершения входа; QR сохраняет облачный пароль | `login/common.ts`, QR на нём |
| 3 | Воркер: вход по номеру | `login/phone.ts`, клиент `login/phone-client.ts` |
| 4 | API: вход по номеру | `/api/phone-login*` |
| 5 | Воркер: облачный пароль подключённых аккаунтов | `accounts/cloud-password.ts`, методы 2FA в `TelegramSession` |
| 6 | API: облачный пароль | `/api/accounts/:id/cloud-password*` |
| 7 | Web: вкладка «По номеру» | третья вкладка диалога «Добавить аккаунт» |
| 8 | Web: облачный пароль в карточке аккаунта | блок «Облачный пароль» с диалогами |
| 9 | e2e и документация | e2e 20, AGENTS.md |
| 10 | Живая проверка | вход по номеру с кодом в Desktop; облачный пароль на выбранном аккаунте |

---

### Task 1: Контракты: вход по номеру и облачный пароль; поле в БД

Всё, на что дальше опираются воркер, API и веб.

- Источник аккаунта `phone` («по номеру»).
- Ввод номера: пробелы, скобки, дефисы и `+` отбрасываются, остаётся 7–15 цифр. Код входа и код из письма — только цифры.
- Состояния входа по номеру.
- DTO состояния облачного пароля и входы `set` / `verify` / `email`.
- Команды `phone.start` и `account.password.*`. В командах пароли и коды — только поля `…Enc` (шифротекст), это проверяет тест.
- Канал входа `accs:login:<id>` и событие `phone.update`.
- Подпись настройки `telegram.qrTimeout` — «Время на вход (QR и по номеру)».
- Миграция `0003` добавляет `accounts.cloud_password_enc`.

**Files:**
- Modify: `packages/shared/src/accounts.ts`
- Modify: `packages/shared/src/commands.ts`
- Modify: `packages/shared/src/events.ts`
- Modify: `packages/shared/src/settings/definitions.ts`
- Test (modify): `packages/shared/test/accounts.test.ts`
- Create: `packages/db/drizzle/0003_cloud_password.sql`
- Modify: `packages/db/src/schema.ts`
- Test (modify): `packages/db/test/schema.test.ts`
- Generated: `packages/db/drizzle/meta/0003_snapshot.json`, `packages/db/drizzle/meta/_journal.json` — не писать руками (команды ниже)

**Interfaces:**
- Consumes: `packages/shared` и `packages/db` после плана 2 (`accounts.ts`, `commands.ts`, `events.ts`, `schema.ts`).
- Produces:
  - `packages/shared/src/accounts.ts`: `ACCOUNT_SOURCES`; `accountSourceLabels: Record<(typeof ACCOUNT_SOURCES)[number], string>`; `startPhoneLoginInput`; `type StartPhoneLoginInput`; `phoneCodeInput`; `PHONE_LOGIN_STATES`; `type PhoneLoginState`; `cloudPasswordInfoDto`; `type CloudPasswordInfoDto`; `verifyCloudPasswordInput`; `setCloudPasswordInput`; `type SetCloudPasswordInput`; `cloudPasswordEmailInput`; `type CloudPasswordEmailInput`; `emailCodeNeeded`; `type EmailCodeNeeded`
  - `packages/shared/src/commands.ts`: `type CloudPasswordError`; `type CloudPasswordInfoResult`; `type CloudPasswordVerifyResult`; `type CloudPasswordSetResult`; `type CloudPasswordEmailResult`; `loginControlChannel`; `loginControlSchema`; `type LoginControl`
  - `packages/db/src/schema.ts`: `ACCOUNT_SOURCES`

- [ ] **Шаг 1: Написать падающий тест**

`packages/shared/test/accounts.test.ts` — изменения

```diff
--- a/packages/shared/test/accounts.test.ts
+++ b/packages/shared/test/accounts.test.ts
@@ -1,5 +1,14 @@
 import { describe, expect, it } from 'vitest'
-import { accountTitle, confirmImportInput } from '../src/accounts.ts'
+import {
+  accountSourceLabels,
+  accountTitle,
+  cloudPasswordEmailInput,
+  confirmImportInput,
+  phoneCodeInput,
+  setCloudPasswordInput,
+  startPhoneLoginInput,
+} from '../src/accounts.ts'
+import { loginControlSchema, workerCommandSchema } from '../src/commands.ts'
 import { appEventSchema } from '../src/events.ts'
 
 describe('accountTitle', () => {
@@ -21,3 +30,54 @@ it('app events carry new codes and QR progress', () => {
   expect(appEventSchema.parse({ type: 'code.new', id: 1, accountId: 'a', code: '575571', date: '2026-10-03T00:00:00.000Z' })).toMatchObject({ code: '575571' })
   expect(appEventSchema.safeParse({ type: 'qr.update', qrId: 'q', state: 'nope' }).success).toBe(false)
 })
+
+describe('phone login input', () => {
+  it('normalizes the phone number to digits and refuses what cannot be one', () => {
+    expect(startPhoneLoginInput.parse({ phone: '+7 (700) 123-45-67', proxyId: null }).phone).toBe('77001234567')
+    expect(startPhoneLoginInput.safeParse({ phone: '12345', proxyId: null }).success).toBe(false)
+    expect(startPhoneLoginInput.safeParse({ phone: 'my phone', proxyId: null }).success).toBe(false)
+  })
+
+  it('takes the code with spaces or dashes and nothing but digits', () => {
+    expect(phoneCodeInput.parse({ code: ' 12 345 ' }).code).toBe('12345')
+    expect(phoneCodeInput.parse({ code: '12-345' }).code).toBe('12345')
+    expect(phoneCodeInput.safeParse({ code: 'abcde' }).success).toBe(false)
+  })
+
+  it('carries code, password, resend and cancel over the login channel', () => {
+    expect(loginControlSchema.parse({ type: 'code', code: '12345' })).toEqual({ type: 'code', code: '12345' })
+    expect(loginControlSchema.safeParse({ type: 'password' }).success).toBe(false)
+    expect(loginControlSchema.parse({ type: 'resend' })).toEqual({ type: 'resend' })
+  })
+
+  it('reports progress as phone.update events', () => {
+    const event = { type: 'phone.update', loginId: 'l', state: 'code_sent', deliveryType: 'app', codeLength: 5, nextType: 'sms', retryAfterSec: 60 }
+    expect(appEventSchema.parse(event)).toMatchObject({ state: 'code_sent', codeLength: 5 })
+    expect(appEventSchema.safeParse({ ...event, state: 'nope' }).success).toBe(false)
+  })
+
+  it('names the new source', () => {
+    expect(accountSourceLabels).toEqual({ tdata: 'tdata', qr: 'QR', phone: 'по номеру' })
+  })
+})
+
+describe('cloud password input', () => {
+  it('needs a new password; current password, hint and email are optional; the email must be one', () => {
+    expect(setCloudPasswordInput.safeParse({ newPassword: '' }).success).toBe(false)
+    expect(setCloudPasswordInput.parse({ newPassword: 'p4ss', hint: ' кот ' })).toEqual({ newPassword: 'p4ss', hint: 'кот' })
+    expect(setCloudPasswordInput.safeParse({ newPassword: 'p4ss', email: 'not-an-email' }).success).toBe(false)
+    expect(setCloudPasswordInput.parse({ currentPassword: 'old', newPassword: 'new', email: 'me@example.com' })).toMatchObject({ email: 'me@example.com' })
+  })
+
+  it('confirms, resends or cancels the recovery email', () => {
+    expect(cloudPasswordEmailInput.parse({ action: 'confirm', code: '123 456' })).toEqual({ action: 'confirm', code: '123456' })
+    expect(cloudPasswordEmailInput.safeParse({ action: 'confirm' }).success).toBe(false)
+    expect(cloudPasswordEmailInput.parse({ action: 'cancel' })).toEqual({ action: 'cancel' })
+  })
+
+  it('sends secrets to the worker only as ciphertext fields', () => {
+    const set = workerCommandSchema.parse({ type: 'account.password.set', accountId: 'a', currentPasswordEnc: null, newPasswordEnc: 'v1:x', hint: null, email: null })
+    expect(Object.keys(set).filter((k) => /password|code/i.test(k)).every((k) => k.endsWith('Enc'))).toBe(true)
+    expect(workerCommandSchema.safeParse({ type: 'account.password.verify', accountId: 'a', password: 'plain' }).success).toBe(false)
+  })
+})
```

`packages/db/test/schema.test.ts` — изменения

```diff
--- a/packages/db/test/schema.test.ts
+++ b/packages/db/test/schema.test.ts
@@ -69,6 +69,11 @@ describe('schema', () => {
     expect(after).toMatchObject({ proxyId: null, status: 'pending_check', device })
   })
 
+  it('keeps the cloud password the panel knows, encrypted, on the account', async () => {
+    const [a] = await t.db.insert(accounts).values({ ...account(2002), cloudPasswordEnc: 'v1:a:b:c' }).returning()
+    expect(a).toMatchObject({ cloudPasswordEnc: 'v1:a:b:c' })
+  })
+
   it('removes auth keys and codes together with the account', async () => {
     const [a] = await t.db.insert(accounts).values(account(2001)).returning()
     await t.db.insert(accountAuth).values([
```

- [ ] **Шаг 2: Убедиться, что тест падает**

```bash
fnm exec --using=26 npx vitest run --project shared packages/shared/test/accounts.test.ts
# FAIL: startPhoneLoginInput / accountSourceLabels / loginControlSchema не экспортируются
```

- [ ] **Шаг 3: Реализация**

`packages/shared/src/accounts.ts` — изменения

```diff
--- a/packages/shared/src/accounts.ts
+++ b/packages/shared/src/accounts.ts
@@ -20,7 +20,8 @@ export const RUNNING_STATUSES: readonly AccountStatus[] = ['pending_check', 'act
 /** Terminal statuses: the session is gone, only deletion makes sense. */
 export const FINAL_STATUSES: readonly AccountStatus[] = ['unauthorized', 'banned']
 
-export const ACCOUNT_SOURCES = ['tdata', 'qr'] as const
+export const ACCOUNT_SOURCES = ['tdata', 'qr', 'phone'] as const
+export const accountSourceLabels: Record<(typeof ACCOUNT_SOURCES)[number], string> = { tdata: 'tdata', qr: 'QR', phone: 'по номеру' }
 export const CLIENT_PROFILES = ['desktop', 'own'] as const
 export const CONNECTION_MODES = ['proxy', 'direct'] as const
 
@@ -167,6 +168,70 @@ export const qrPasswordInput = z.object({ password: z.string().min(1).max(256) }
 export const QR_STATES = ['waiting', 'scanned', 'password_needed', 'password_invalid', 'done', 'failed', 'expired', 'cancelled'] as const
 export type QrState = (typeof QR_STATES)[number]
 
+// ---- login by phone number ----
+
+/** E.164 without the plus: 7 to 15 digits. Spaces, dashes, brackets and a leading + are dropped. */
+const phoneNumber = z
+  .string()
+  .transform((v) => v.replace(/[\s()+-]/g, ''))
+  .pipe(z.string().regex(/^\d{7,15}$/, 'Номер — от 7 до 15 цифр, например +7 700 123 45 67'))
+
+/** Login and email codes are digits; people paste them with spaces or dashes. */
+const digitsCode = z
+  .string()
+  .transform((v) => v.replace(/[\s-]/g, ''))
+  .pipe(z.string().regex(/^\d{3,10}$/, 'Код — только цифры'))
+
+export const startPhoneLoginInput = z.object({ phone: phoneNumber, proxyId: z.string().uuid().nullable() })
+export type StartPhoneLoginInput = z.output<typeof startPhoneLoginInput>
+export const phoneCodeInput = z.object({ code: digitsCode })
+
+export const PHONE_LOGIN_STATES = ['code_sent', 'code_invalid', 'code_expired', 'password_needed', 'password_invalid', 'done', 'failed', 'expired', 'cancelled'] as const
+export type PhoneLoginState = (typeof PHONE_LOGIN_STATES)[number]
+
+// ---- cloud password (2FA) of an account ----
+
+const cloudPassword = z.string().min(1, 'Введите пароль').max(256)
+
+/** What Telegram says about the account's cloud password, plus whether the panel knows it. */
+export const cloudPasswordInfoDto = z.object({
+  hasPassword: z.boolean(),
+  hint: z.string().nullable(),
+  /** the panel has the password stored */
+  known: z.boolean(),
+  hasRecovery: z.boolean(),
+  /** the confirmed recovery email: Telegram tells it only to someone who knows the password */
+  recoveryEmail: z.string().nullable(),
+  /** a recovery email still waiting for its code, masked by Telegram */
+  unconfirmedEmailPattern: z.string().nullable(),
+  /** someone asked Telegram to reset the password: it goes at this time unless declined */
+  pendingResetAt: z.string().nullable(),
+})
+export type CloudPasswordInfoDto = z.output<typeof cloudPasswordInfoDto>
+
+export const verifyCloudPasswordInput = z.object({ password: cloudPassword })
+
+export const setCloudPasswordInput = z.object({
+  /** only when the panel does not know the current password */
+  currentPassword: cloudPassword.optional(),
+  newPassword: cloudPassword,
+  hint: z.string().trim().max(128).optional(),
+  /** a recovery email: Telegram mails a code to confirm it */
+  email: z.string().trim().email('Неверная почта').max(256).optional(),
+})
+export type SetCloudPasswordInput = z.output<typeof setCloudPasswordInput>
+
+export const cloudPasswordEmailInput = z.discriminatedUnion('action', [
+  z.object({ action: z.literal('confirm'), code: digitsCode }),
+  z.object({ action: z.literal('resend') }),
+  z.object({ action: z.literal('cancel') }),
+])
+export type CloudPasswordEmailInput = z.output<typeof cloudPasswordEmailInput>
+
+/** The recovery email is set but waits for the code Telegram mailed. */
+export const emailCodeNeeded = z.object({ pattern: z.string().nullable(), length: z.number().nullable() })
+export type EmailCodeNeeded = z.output<typeof emailCodeNeeded>
+
 /** Shown under an account label when there is no label: phone, @username or Telegram id. */
 export function accountTitle(a: { label?: string | null; phone?: string | null; username?: string | null; tgUserId?: number | null }): string {
   if (a.label) return a.label
```

`packages/shared/src/commands.ts` — изменения

```diff
--- a/packages/shared/src/commands.ts
+++ b/packages/shared/src/commands.ts
@@ -1,5 +1,5 @@
 import { z } from 'zod'
-import type { AccountSessionDto } from './accounts.ts'
+import type { AccountSessionDto, CloudPasswordInfoDto, EmailCodeNeeded } from './accounts.ts'
 
 /** BullMQ queue the api uses to ask the worker to act on accounts and proxies. */
 export const COMMANDS_QUEUE = 'worker-commands'
@@ -14,6 +14,19 @@ export const workerCommandSchema = z.discriminatedUnion('type', [
   z.object({ type: z.literal('proxy.check'), proxyId: z.string() }),
   z.object({ type: z.literal('proxy.sync') }),
   z.object({ type: z.literal('qr.start'), qrId: z.string(), proxyId: z.string().nullable(), adminId: z.string().nullable() }),
+  z.object({ type: z.literal('phone.start'), loginId: z.string(), phone: z.string(), proxyId: z.string().nullable(), adminId: z.string().nullable() }),
+  // cloud password: secrets travel encrypted with APP_ENCRYPTION_KEY (…Enc), never in clear in Redis
+  z.object({ type: z.literal('account.password.info'), accountId: z.string() }),
+  z.object({ type: z.literal('account.password.verify'), accountId: z.string(), passwordEnc: z.string() }),
+  z.object({
+    type: z.literal('account.password.set'),
+    accountId: z.string(),
+    currentPasswordEnc: z.string().nullable(),
+    newPasswordEnc: z.string(),
+    hint: z.string().nullable(),
+    email: z.string().nullable(),
+  }),
+  z.object({ type: z.literal('account.password.email'), accountId: z.string(), action: z.enum(['confirm', 'resend', 'cancel']), codeEnc: z.string().nullable() }),
 ])
 
 export type WorkerCommand = z.output<typeof workerCommandSchema>
@@ -28,6 +41,25 @@ export interface AccountStopResult {
 export type AccountSessionsResult = { sessions: AccountSessionDto[] } | { error: 'not_running' }
 export type TerminateSessionResult = { ok: true } | { error: 'not_running' }
 
+/** Why a cloud password operation did not happen (the api turns these into messages). */
+export type CloudPasswordError =
+  | { error: 'not_running' }
+  /** the password typed by the admin is wrong */
+  | { error: 'wrong_password' }
+  /** the stored password no longer fits — changed outside the panel; it was forgotten */
+  | { error: 'stale_password' }
+  /** the account has a password the panel does not know, and none was given */
+  | { error: 'password_unknown' }
+  | { error: 'too_fresh'; retryAfterSec: number }
+  | { error: 'email_invalid' }
+  | { error: 'code_invalid' }
+  | { error: 'code_expired' }
+  | { error: 'other'; message: string }
+export type CloudPasswordInfoResult = { info: CloudPasswordInfoDto } | CloudPasswordError
+export type CloudPasswordVerifyResult = { ok: true } | CloudPasswordError
+export type CloudPasswordSetResult = { ok: true } | { emailCodeNeeded: EmailCodeNeeded } | CloudPasswordError
+export type CloudPasswordEmailResult = { ok: true } | CloudPasswordError
+
 /** Redis pub/sub channel carrying the 2FA password (or a cancel) to a running QR login; never stored. */
 export const qrControlChannel = (qrId: string) => `accs:qr:${qrId}`
 export const qrControlSchema = z.discriminatedUnion('type', [
@@ -35,3 +67,13 @@ export const qrControlSchema = z.discriminatedUnion('type', [
   z.object({ type: z.literal('cancel') }),
 ])
 export type QrControl = z.output<typeof qrControlSchema>
+
+/** Redis pub/sub channel of a running phone-number login: the code, the 2FA password, resend and cancel; never stored. */
+export const loginControlChannel = (loginId: string) => `accs:login:${loginId}`
+export const loginControlSchema = z.discriminatedUnion('type', [
+  z.object({ type: z.literal('code'), code: z.string() }),
+  z.object({ type: z.literal('password'), password: z.string() }),
+  z.object({ type: z.literal('resend') }),
+  z.object({ type: z.literal('cancel') }),
+])
+export type LoginControl = z.output<typeof loginControlSchema>
```

`packages/shared/src/events.ts` — изменения

```diff
--- a/packages/shared/src/events.ts
+++ b/packages/shared/src/events.ts
@@ -1,5 +1,5 @@
 import { z } from 'zod'
-import { QR_STATES } from './accounts.ts'
+import { PHONE_LOGIN_STATES, QR_STATES } from './accounts.ts'
 
 /** Redis pub/sub channel shared by api and worker; also the source of the SSE stream. */
 export const EVENTS_CHANNEL = 'accs:events'
@@ -33,6 +33,22 @@ export const appEventSchema = z.discriminatedUnion('type', [
     accountId: z.string().optional(),
     message: z.string().optional(),
   }),
+  /** progress of a phone-number login started in the panel */
+  z.object({
+    type: z.literal('phone.update'),
+    loginId: z.string(),
+    state: z.enum(PHONE_LOGIN_STATES),
+    /** where Telegram sent the code: app, sms, call, email… */
+    deliveryType: z.string().optional(),
+    codeLength: z.number().optional(),
+    /** how «send again» would deliver it; 'none' — it cannot */
+    nextType: z.string().optional(),
+    /** «send again» works after this many seconds */
+    retryAfterSec: z.number().optional(),
+    hint: z.string().optional(),
+    accountId: z.string().optional(),
+    message: z.string().optional(),
+  }),
 ])
 
 export type AppEvent = z.output<typeof appEventSchema>
```

`packages/shared/src/settings/definitions.ts` — изменения

```diff
--- a/packages/shared/src/settings/definitions.ts
+++ b/packages/shared/src/settings/definitions.ts
@@ -71,9 +71,9 @@ export const settingsDef = {
     help: `Ключ вашего приложения с my.telegram.org (страница API development tools), парный к «Свой api_id».\n\n${SECRET_NOTE}`,
   }),
   'telegram.qrTimeout': duration({
-    group: 'telegram', label: 'Таймаут входа по QR', default: '5m', min: '1m', max: '15m',
-    description: 'Сколько ждать сканирования QR-кода и пароля 2FA.',
-    help: 'Общее время на вход по QR: показ кода, сканирование в приложении Telegram и, если включена двухэтапная проверка, ввод пароля. Когда время выходит, попытка отменяется — начните вход заново.',
+    group: 'telegram', label: 'Время на вход (QR и по номеру)', default: '5m', min: '1m', max: '15m',
+    description: 'Сколько ждать сканирования QR-кода или ввода кода, а также облачного пароля.',
+    help: 'Общее время на один вход в панели. По QR: показ кода, сканирование в приложении Telegram и, если включён облачный пароль, его ввод. По номеру: отправка кода, его ввод и облачный пароль. Когда время выходит, попытка отменяется — начните вход заново.',
   }),
 
   // notifications
```

`packages/db/src/schema.ts` — изменения

```diff
--- a/packages/db/src/schema.ts
+++ b/packages/db/src/schema.ts
@@ -123,7 +123,7 @@ export const proxies = pgTable(
   ],
 )
 
-export const ACCOUNT_SOURCES = ['tdata', 'qr'] as const
+export const ACCOUNT_SOURCES = ['tdata', 'qr', 'phone'] as const
 export const CLIENT_PROFILES = ['desktop', 'own'] as const
 export const CONNECTION_MODES = ['proxy', 'direct'] as const
 export const ACCOUNT_STATUSES = ['pending_check', 'active', 'paused', 'proxy_down', 'unauthorized', 'banned', 'frozen', 'error'] as const
@@ -162,6 +162,8 @@ export const accounts = pgTable(
     frozenUntil: ts('frozen_until'),
     /** one-time mtcute string session from a tdata import (encrypted); the worker imports and clears it */
     sessionImportEnc: text('session_import_enc'),
+    /** the account's cloud (2FA) password when the panel knows it; written by the worker after Telegram accepted it */
+    cloudPasswordEnc: text('cloud_password_enc'),
     createdAt: createdAt(),
     updatedAt: updatedAt(),
   },
```

- [ ] **Шаг 4: Сгенерировать миграцию**

```bash
fnm exec --using=26 pnpm --filter @workspace/db db:generate --name cloud_password
# создаёт packages/db/drizzle/0003_cloud_password.sql и снимок в packages/db/drizzle/meta/
```

Сверить сгенерированный SQL с ожидаемым (`packages/db/drizzle/0003_cloud_password.sql`):

```sql
ALTER TABLE "accounts" ADD COLUMN "cloud_password_enc" text;
```

- [ ] **Шаг 5: Проверки**

```bash
fnm exec --using=26 pnpm typecheck
fnm exec --using=26 pnpm lint
fnm exec --using=26 npx vitest run --project db --project shared
# всё зелёное
```

- [ ] **Шаг 6: Коммит**

```bash
git add -A
git commit -F - <<'MSG'
feat(shared,db): contracts for phone-number login and cloud password; accounts.cloud_password_enc
MSG
```

---

### Task 2: Воркер: общий модуль завершения входа; QR сохраняет облачный пароль

Части, общие для QR и номера, выносятся в `login/common.ts`:
- проверка и расшифровка свободного прокси;
- профиль устройства из настроек;
- подписка на приватный Redis-канал входа;
- `finish`: дубликат (новая сессия выходит), иначе аккаунт с session string и введённым облачным паролем (зашифрованы), аудит, `accounts.changed`, уничтожение клиента входа до передачи аккаунта воркеру.

QR-вход переходит на модуль и запоминает пароль, с которым прошёл вход.

**Files:**
- Create: `apps/worker/src/login/common.ts`
- Modify: `apps/worker/src/qr/login.ts`
- Test (modify): `apps/worker/test/qr-login.test.ts`

**Interfaces:**
- Consumes: `createQrLogin`, `QrClient` (план 2); `accounts.cloudPasswordEnc` (задача 1).
- Produces:
  - `apps/worker/src/login/common.ts`: `interface LoginClient`; `interface FinishLogin`; `type FinishResult`; `createLoginKit(deps: WorkerDeps)`; `type LoginKit`

- [ ] **Шаг 1: Написать падающий тест**

`apps/worker/test/qr-login.test.ts` — изменения

```diff
--- a/apps/worker/test/qr-login.test.ts
+++ b/apps/worker/test/qr-login.test.ts
@@ -88,6 +88,8 @@ describe('QR login', () => {
     const [account] = await w.t.db.select().from(accounts).where(eq(accounts.tgUserId, 31337))
     expect(account).toMatchObject({ source: 'qr', clientProfile: 'own', connectionMode: 'direct', status: 'pending_check', phone: '77009998877' })
     expect(w.deps.cipher.decrypt(account!.sessionImportEnc!)).toBe('exported-session')
+    // the cloud password that let the login through is kept (encrypted) for the account card
+    expect(w.deps.cipher.decrypt(account!.cloudPasswordEnc!)).toBe('right')
     expect(onAccountCreated).toHaveBeenCalledWith(account!.id)
     // «неверный пароль» stays on screen (with the hint) until the next try — mtcute asks for the password right after
     expect(states.map((s) => (s as { state: string }).state)).toEqual(['waiting', 'scanned', 'password_needed', 'password_invalid', 'done'])
@@ -97,6 +99,14 @@ describe('QR login', () => {
     expect(destroyedAtHandOff).toEqual([true])
   })
 
+  it('keeps no cloud password for an account without one', async () => {
+    const qrId = randomUUID()
+    const { factory } = scriptedFactory(52525)
+    await createQrLogin(w.deps, factory).run({ qrId, proxyId: null, adminId: null })
+    const [account] = await w.t.db.select().from(accounts).where(eq(accounts.tgUserId, 52525))
+    expect(account).toMatchObject({ source: 'qr', cloudPasswordEnc: null })
+  })
+
   it('logs the new session out when the account is already in the panel', async () => {
     const device = { deviceModel: 'Desktop', systemVersion: 'Windows 11 x64', appVersion: '7.2.9 x64', langCode: 'ru' }
     const [existing] = await w.t.db.insert(accounts).values({ tgUserId: 4242, source: 'tdata', clientProfile: 'desktop', device, connectionMode: 'direct' }).returning()
@@ -108,6 +118,7 @@ describe('QR login', () => {
     off()
     expect(made[0]!.loggedOut).toBe(true)
     expect(await w.t.db.select().from(accounts)).toHaveLength(1)
+    expect(made[0]!.destroyed).toBe(true)
   })
 
   it('stops on cancel and on timeout', async () => {
```

- [ ] **Шаг 2: Убедиться, что тест падает**

```bash
fnm exec --using=26 npx vitest run --project worker apps/worker/test/qr-login.test.ts
# FAIL: TypeError: Cannot read properties of null (reading 'split') — cloudPasswordEnc пуст
```

- [ ] **Шаг 3: Реализация**

`apps/worker/src/login/common.ts` — новый файл

```ts
import { accounts, and, eq, isNull, proxies, type AccountDevice } from '@workspace/db'
import { writeAudit, type Redis } from '@workspace/server'
import type { z } from 'zod'
import type { WorkerDeps } from '../deps.ts'
import type { ProxyEndpoint } from '../proxies/checker.ts'
import type { SessionProfile } from '../telegram/session.ts'

/** What finishing a login needs from the throwaway client (QR or phone). */
export interface LoginClient {
  exportSession(): Promise<string>
  logOut(): Promise<void>
  destroy(): Promise<void>
}

export interface FinishLogin {
  client: LoginClient
  profile: SessionProfile
  source: 'qr' | 'phone'
  proxyId: string | null
  adminId: string | null
  /** the cloud password that let the login through, if the account has one */
  cloudPassword: string | null
  device: AccountDevice
}

export type FinishResult = { accountId: string } | { duplicateOf: string }

/** The pieces QR and phone-number logins share: the proxy, the control channel, and saving the new account. */
export function createLoginKit(deps: WorkerDeps) {
  const { db, settings, cipher, bus } = deps

  return {
    /** A free, usable proxy (the same rule as the api's isProxyFree), or null for an explicit «direct». */
    async proxyEndpoint(proxyId: string | null): Promise<ProxyEndpoint | null> {
      if (!proxyId) return null
      const [row] = await db
        .select()
        .from(proxies)
        .leftJoin(accounts, eq(accounts.proxyId, proxies.id))
        .where(and(eq(proxies.id, proxyId), isNull(proxies.disabledAt), isNull(accounts.id)))
      if (!row || !['ok', 'unchecked', 'failing'].includes(row.proxies.status)) throw new Error('Прокси недоступен или уже занят')
      const p = row.proxies
      return { type: p.type, host: p.host, port: p.port, username: p.username, password: p.passwordEnc ? cipher.decrypt(p.passwordEnc) : null }
    },

    /** The device the login presents (and the account keeps): the Desktop profile from settings. */
    device(): AccountDevice {
      return {
        deviceModel: settings.get('telegram.desktop.deviceModel'),
        systemVersion: settings.get('telegram.desktop.systemVersion'),
        appVersion: settings.get('telegram.desktop.appVersion'),
        langCode: settings.get('telegram.desktop.langCode'),
      }
    },

    /** A private subscriber connection per login: secrets and commands arrive on the login's own channel. */
    async subscribe<T>(redis: Redis, channel: string, schema: z.ZodType<T>, onMessage: (message: T) => void): Promise<() => Promise<void>> {
      const sub = redis.duplicate()
      await sub.subscribe(channel)
      sub.on('message', (_channel: string, raw: string) => {
        try {
          onMessage(schema.parse(JSON.parse(raw)))
        } catch {
          // malformed control message: ignore
        }
      })
      return async () => {
        await sub.quit().catch(() => {})
      }
    },

    /**
     * Saves the new account with its session (and the cloud password, if one was typed), then destroys the login
     * client: one auth key — one client, the account manager starts its own. An account already in the panel is
     * refused and the new session logged out, so no unused device is left behind.
     */
    async finish(params: FinishLogin): Promise<FinishResult> {
      const { client, profile } = params
      const [existing] = await db.select({ id: accounts.id }).from(accounts).where(eq(accounts.tgUserId, profile.tgUserId))
      if (existing) {
        await client.logOut().catch(() => {})
        await client.destroy().catch(() => {})
        return { duplicateOf: existing.id }
      }
      const session = await client.exportSession()
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
          source: params.source,
          clientProfile: 'own',
          device: params.device,
          connectionMode: params.proxyId ? 'proxy' : 'direct',
          proxyId: params.proxyId,
          status: 'pending_check',
          sessionImportEnc: cipher.encrypt(session),
          cloudPasswordEnc: params.cloudPassword ? cipher.encrypt(params.cloudPassword) : null,
        })
        .returning({ id: accounts.id })
      await writeAudit(db, {
        actor: params.adminId ? { type: 'admin', adminId: params.adminId } : { type: 'system' },
        action: `account.${params.source}.created`,
        targetType: 'account',
        targetId: created!.id,
        result: 'ok',
      })
      await bus.publish({ type: 'accounts.changed', ids: [created!.id] })
      await client.destroy().catch(() => {})
      return { accountId: created!.id }
    },
  }
}

export type LoginKit = ReturnType<typeof createLoginKit>
```

`apps/worker/src/qr/login.ts` — заменить содержимое целиком

```ts
import type { QrState } from '@workspace/shared/accounts'
import { qrControlChannel, qrControlSchema } from '@workspace/shared/commands'
import { parseDuration } from '@workspace/shared/duration'
import type { WorkerDeps } from '../deps.ts'
import { createLoginKit } from '../login/common.ts'
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
 * Redis channel (never stored in Redis), and on success saves the account with its session — and the cloud
 * password that let it through — for the account manager.
 */
export function createQrLogin(deps: WorkerDeps, factory: QrClientFactory, options: QrLoginOptions = {}) {
  const { settings, bus, logger } = deps
  const kit = createLoginKit(deps)

  const update = (qrId: string, state: QrState, extra: { url?: string; expiresAt?: string; hint?: string; accountId?: string; message?: string } = {}) =>
    bus.publish({ type: 'qr.update', qrId, state, ...extra })

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
      const stopControl = await kit.subscribe(deps.redis, qrControlChannel(qrId), qrControlSchema, (message) => {
        if (message.type === 'cancel') abort.abort(new Error('cancelled'))
        if (message.type === 'password' && passwordWaiter) {
          passwordWaiter(message.password)
          passwordWaiter = null
        }
      })

      let client: ReturnType<QrClientFactory> | undefined
      try {
        const proxy = await kit.proxyEndpoint(proxyId)
        const device = kit.device()
        client = factory({ apiId, apiHash, device, proxy })
        const qrClient = client
        let hint: string | null | undefined
        // mtcute reports a wrong password and asks again at once: keep «неверный пароль» on screen until the next try
        let passwordWasWrong = false
        // the last password typed: signIn only returns once it was the right one
        let cloudPassword: string | null = null
        const profile = await qrClient.signIn({
          abortSignal: abort.signal,
          onUrlUpdated: (url, expires) => void update(qrId, 'waiting', { url, expiresAt: expires.toISOString() }),
          onQrScanned: () => void update(qrId, 'scanned'),
          password: async () => {
            if (hint === undefined) hint = await qrClient.passwordHint().catch(() => null)
            if (!passwordWasWrong) await update(qrId, 'password_needed', hint ? { hint } : {})
            const password = await new Promise<string>((resolve, reject) => {
              passwordWaiter = resolve
              abort.signal.addEventListener('abort', () => reject(abort.signal.reason), { once: true })
            })
            cloudPassword = password
            return password
          },
          invalidPasswordCallback: () => {
            passwordWasWrong = true
            void update(qrId, 'password_invalid', hint ? { hint } : {})
          },
        })

        const result = await kit.finish({ client: qrClient, profile, source: 'qr', proxyId, adminId, cloudPassword, device })
        client = undefined
        if ('duplicateOf' in result) {
          await update(qrId, 'failed', { message: 'Этот аккаунт уже есть в панели', accountId: result.duplicateOf })
          return
        }
        await update(qrId, 'done', { accountId: result.accountId })
        await options.onAccountCreated?.(result.accountId)
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
fnm exec --using=26 npx vitest run --project worker
# всё зелёное
```

- [ ] **Шаг 5: Коммит**

```bash
git add -A
git commit -F - <<'MSG'
refactor(worker): shared login kit (proxy, control channel, saving the account) — QR now keeps the cloud password that let it through
MSG
```

---

### Task 3: Воркер: вход по номеру

`PhoneClient` — узкий интерфейс к временному клиенту mtcute в `MemoryStorage`, со своим api_id. Методы: `sendCode`, `resendCode`, `signIn`, `checkPassword`, `cancelCode`, подсказка пароля, экспорт сессии. Общий `profileOf` используют и QR, и номер.

Поток `createPhoneLogin`:
1. Отправка кода → `code_sent` (способ доставки, длина, следующий способ, через сколько можно повторить).
2. Сообщения из канала:
   - код: неверный → `code_invalid`, истёк → `code_expired`, нужен облачный пароль → `password_needed` с подсказкой;
   - пароль: неверный → `password_invalid`, подсказка остаётся;
   - «ещё раз» → `resendCode`;
   - отмена → `cancelCode` и `cancelled`.
3. Таймаут — `telegram.qrTimeout`.

Если Telegram авторизовал сразу (`sentCodeSuccess`), вход завершается без кода. Отказы Telegram и mtcute переводятся в понятные сообщения: неверный или заблокированный номер, регистрация, `FLOOD_WAIT`, почта для входа, платный вход.

**Files:**
- Create: `apps/worker/src/login/phone-client.ts`
- Create: `apps/worker/src/login/phone.ts`
- Create: `apps/worker/src/login/profile.ts`
- Modify: `apps/worker/src/main.ts`
- Modify: `apps/worker/src/qr/client.ts`
- Test: `apps/worker/test/phone-login.test.ts`

**Interfaces:**
- Consumes: `createLoginKit` (задача 2); `loginControlChannel`, `loginControlSchema`, `PhoneLoginState` (задача 1).
- Produces:
  - `apps/worker/src/login/phone-client.ts`: `interface SentCodeInfo`; `interface PhoneClient`; `type PhoneClientFactory`; `createMtcutePhoneClient: PhoneClientFactory`
  - `apps/worker/src/login/phone.ts`: `interface PhoneStart`; `interface PhoneLoginOptions`; `phoneLoginError(err: unknown): string`; `createPhoneLogin(deps: WorkerDeps, factory: PhoneClientFactory, options: PhoneLoginOptions = {})`
  - `apps/worker/src/login/profile.ts`: `profileOf(user: User): SessionProfile`

- [ ] **Шаг 1: Написать падающий тест**

`apps/worker/test/phone-login.test.ts` — новый файл

```ts
import { randomUUID } from 'node:crypto'
import { accounts, eq } from '@workspace/db'
import type { AppEvent } from '@workspace/shared/events'
import { loginControlChannel } from '@workspace/shared/commands'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PhoneClient, PhoneClientFactory, SentCodeInfo } from '../src/login/phone-client.ts'
import { createPhoneLogin } from '../src/login/phone.ts'
import type { SessionProfile } from '../src/telegram/session.ts'
import { rpcError } from './fake-session.ts'
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

const sent = (over: Partial<SentCodeInfo> = {}): SentCodeInfo => ({ phoneCodeHash: 'hash-1', deliveryType: 'app', codeLength: 5, nextType: 'sms', timeoutSec: 60, ...over })
const profile = (tgUserId: number): SessionProfile => ({ tgUserId, phone: '77001234567', username: null, firstName: 'Phone', lastName: null, isPremium: false, dcId: 2 })

type FakePhoneClient = PhoneClient & { destroyed: boolean; loggedOut: boolean; cancelled: boolean; calls: string[] }

/** Telegram as the test scripts it: the right code is 12345, the right cloud password «right» (if `twoFa`). */
function scripted(tgUserId: number, opts: { twoFa?: boolean; sendCode?: () => Promise<SentCodeInfo | SessionProfile> } = {}) {
  const made: FakePhoneClient[] = []
  const factory: PhoneClientFactory = () => {
    let expired = false
    const client: FakePhoneClient = {
      destroyed: false,
      loggedOut: false,
      cancelled: false,
      calls: [],
      sendCode: async (phone) => {
        client.calls.push(`sendCode ${phone}`)
        return opts.sendCode ? opts.sendCode() : sent()
      },
      resendCode: async () => {
        client.calls.push('resendCode')
        expired = false
        return sent({ phoneCodeHash: 'hash-2', deliveryType: 'sms', nextType: 'call' })
      },
      signIn: async (_phone, hash, code) => {
        client.calls.push(`signIn ${hash} ${code}`)
        if (code === '00000') {
          expired = true
          throw rpcError(400, 'PHONE_CODE_EXPIRED')
        }
        if (expired || code !== '12345') throw rpcError(400, 'PHONE_CODE_INVALID')
        if (opts.twoFa) throw rpcError(401, 'SESSION_PASSWORD_NEEDED')
        return profile(tgUserId)
      },
      checkPassword: async (password) => {
        client.calls.push('checkPassword')
        if (password !== 'right') throw rpcError(400, 'PASSWORD_HASH_INVALID')
        return profile(tgUserId)
      },
      cancelCode: async () => {
        client.cancelled = true
      },
      passwordHint: async () => 'кличка кота',
      exportSession: async () => 'phone-session',
      logOut: async () => {
        client.loggedOut = true
      },
      destroy: async () => {
        client.destroyed = true
      },
    }
    made.push(client)
    return client
  }
  return { factory, made }
}

async function collect(loginId: string) {
  const states: Extract<AppEvent, { type: 'phone.update' }>[] = []
  const off = w.deps.bus.subscribe((e) => {
    if (e.type === 'phone.update' && e.loginId === loginId) states.push(e)
  })
  return { states, off, names: () => states.map((s) => s.state) }
}
const send = (loginId: string, message: unknown) => w.deps.redis.publish(loginControlChannel(loginId), JSON.stringify(message))
const start = (loginId: string) => ({ loginId, phone: '77001234567', proxyId: null, adminId: null })

describe('phone login', () => {
  it('takes the code (wrong first) and the cloud password (wrong first), then saves the account with its session and password', async () => {
    const loginId = randomUUID()
    const { factory, made } = scripted(61001, { twoFa: true })
    const destroyedAtHandOff: boolean[] = []
    const onAccountCreated = vi.fn(() => {
      destroyedAtHandOff.push(made[0]!.destroyed)
    })
    const { states, off, names } = await collect(loginId)
    const run = createPhoneLogin(w.deps, factory, { onAccountCreated }).run(start(loginId))

    await vi.waitFor(() => expect(names()).toContain('code_sent'))
    expect(states[0]).toMatchObject({ state: 'code_sent', deliveryType: 'app', codeLength: 5, nextType: 'sms', retryAfterSec: 60 })
    await send(loginId, { type: 'code', code: '11111' })
    await vi.waitFor(() => expect(names()).toContain('code_invalid'))
    await send(loginId, { type: 'code', code: '12345' })
    await vi.waitFor(() => expect(names()).toContain('password_needed'))
    await send(loginId, { type: 'password', password: 'wrong' })
    await vi.waitFor(() => expect(names()).toContain('password_invalid'))
    await send(loginId, { type: 'password', password: 'right' })
    await run
    await vi.waitFor(() => expect(states.at(-1)).toMatchObject({ state: 'done' }))
    off()

    expect(names()).toEqual(['code_sent', 'code_invalid', 'password_needed', 'password_invalid', 'done'])
    expect(states[2]).toMatchObject({ hint: 'кличка кота' })
    expect(states[3]).toMatchObject({ hint: 'кличка кота' })
    const [account] = await w.t.db.select().from(accounts).where(eq(accounts.tgUserId, 61001))
    expect(account).toMatchObject({ source: 'phone', clientProfile: 'own', connectionMode: 'direct', status: 'pending_check' })
    expect(w.deps.cipher.decrypt(account!.sessionImportEnc!)).toBe('phone-session')
    expect(w.deps.cipher.decrypt(account!.cloudPasswordEnc!)).toBe('right')
    expect(onAccountCreated).toHaveBeenCalledWith(account!.id)
    expect(destroyedAtHandOff).toEqual([true])
    expect(made[0]!.calls[0]).toBe('sendCode 77001234567')
  })

  it('sends the code again by the next method, and after an expired code takes the new one', async () => {
    const loginId = randomUUID()
    const { factory, made } = scripted(61002)
    const { states, off, names } = await collect(loginId)
    const run = createPhoneLogin(w.deps, factory).run(start(loginId))
    await vi.waitFor(() => expect(names()).toContain('code_sent'))
    await send(loginId, { type: 'code', code: '00000' })
    await vi.waitFor(() => expect(names()).toContain('code_expired'))
    await send(loginId, { type: 'resend' })
    await vi.waitFor(() => expect(names().filter((n) => n === 'code_sent')).toHaveLength(2))
    expect(states.at(-1)).toMatchObject({ deliveryType: 'sms', nextType: 'call' })
    await send(loginId, { type: 'code', code: '12345' })
    await run
    await vi.waitFor(() => expect(states.at(-1)).toMatchObject({ state: 'done' }))
    off()
    expect(made[0]!.calls).toContain('signIn hash-2 12345')
    const [account] = await w.t.db.select().from(accounts).where(eq(accounts.tgUserId, 61002))
    expect(account).toMatchObject({ source: 'phone', cloudPasswordEnc: null })
  })

  it('refuses an account that is already in the panel and logs the new session out', async () => {
    const device = { deviceModel: 'Desktop', systemVersion: 'Windows 11 x64', appVersion: '7.2.9 x64', langCode: 'ru' }
    const [existing] = await w.t.db.insert(accounts).values({ tgUserId: 61003, source: 'tdata', clientProfile: 'desktop', device, connectionMode: 'direct' }).returning()
    const loginId = randomUUID()
    const { factory, made } = scripted(61003)
    const { states, off, names } = await collect(loginId)
    const run = createPhoneLogin(w.deps, factory).run(start(loginId))
    await vi.waitFor(() => expect(names()).toContain('code_sent'))
    await send(loginId, { type: 'code', code: '12345' })
    await run
    await vi.waitFor(() => expect(states.at(-1)).toMatchObject({ state: 'failed', accountId: existing!.id, message: 'Этот аккаунт уже есть в панели' }))
    off()
    expect(made[0]!.loggedOut).toBe(true)
    expect(made[0]!.destroyed).toBe(true)
    expect(await w.t.db.select().from(accounts)).toHaveLength(1)
  })

  it('stops on cancel (asking Telegram to cancel the code) and on timeout', async () => {
    const cancelId = randomUUID()
    const first = scripted(61004)
    const cancelled = await collect(cancelId)
    const run = createPhoneLogin(w.deps, first.factory).run(start(cancelId))
    await vi.waitFor(() => expect(cancelled.names()).toContain('code_sent'))
    await send(cancelId, { type: 'cancel' })
    await run
    await vi.waitFor(() => expect(cancelled.states.at(-1)).toMatchObject({ state: 'cancelled' }))
    cancelled.off()
    expect(first.made[0]!.cancelled).toBe(true)
    expect(first.made[0]!.destroyed).toBe(true)

    const timeoutId = randomUUID()
    const second = scripted(61005)
    const timedOut = await collect(timeoutId)
    await createPhoneLogin(w.deps, second.factory, { timeoutMs: 80 }).run(start(timeoutId))
    await vi.waitFor(() => expect(timedOut.states.at(-1)).toMatchObject({ state: 'expired' }))
    timedOut.off()
    expect(await w.t.db.select().from(accounts)).toHaveLength(0)
  })

  it('logs in at once when Telegram authorizes without a code', async () => {
    const loginId = randomUUID()
    const { factory } = scripted(61006, { sendCode: async () => profile(61006) })
    const { states, off } = await collect(loginId)
    await createPhoneLogin(w.deps, factory).run(start(loginId))
    await vi.waitFor(() => expect(states.at(-1)).toMatchObject({ state: 'done' }))
    off()
    expect(states.map((s) => s.state)).toEqual(['done'])
  })

  it('explains what Telegram refused', async () => {
    const cases: [() => Promise<SentCodeInfo | SessionProfile>, string][] = [
      [async () => Promise.reject(rpcError(400, 'PHONE_NUMBER_INVALID')), 'Неверный номер'],
      [async () => Promise.reject(rpcError(400, 'PHONE_NUMBER_BANNED')), 'Номер заблокирован Telegram'],
      [async () => Promise.reject(rpcError(400, 'PHONE_NUMBER_UNOCCUPIED')), 'На этот номер нет аккаунта Telegram — регистрация через панель не поддерживается'],
      [
        async () => Promise.reject(Object.assign(rpcError(420, 'FLOOD_WAIT_%d'), { seconds: 600 })),
        'Слишком много попыток — подождите 10 мин',
      ],
      [async () => sent({ deliveryType: 'email_required' }), 'Telegram требует привязать почту для входа — сделайте это в официальном приложении'],
      [
        async () => Promise.reject(new Error('Payment is required to sign in, please log in with a first-party client first')),
        'Telegram требует платный вход для неофициальных приложений — войдите сначала в официальном',
      ],
    ]
    for (const [sendCode, message] of cases) {
      const loginId = randomUUID()
      const { factory } = scripted(61007, { sendCode })
      const { states, off } = await collect(loginId)
      await createPhoneLogin(w.deps, factory).run(start(loginId))
      await vi.waitFor(() => expect(states.at(-1)).toMatchObject({ state: 'failed', message }))
      off()
    }
  })

  it('needs the own api_id', async () => {
    await w.deps.settings.update({ 'telegram.own.apiId': null }, { adminId: null })
    try {
      const loginId = randomUUID()
      const { factory, made } = scripted(61008)
      const { states, off } = await collect(loginId)
      await createPhoneLogin(w.deps, factory).run(start(loginId))
      await vi.waitFor(() => expect(states.at(-1)).toMatchObject({ state: 'failed', message: 'Не задан свой api_id / api_hash (Настройки → Telegram)' }))
      off()
      expect(made).toHaveLength(0)
    } finally {
      await w.deps.settings.update({ 'telegram.own.apiId': 123456 }, { adminId: null })
    }
  })
})
```

- [ ] **Шаг 2: Убедиться, что тест падает**

```bash
fnm exec --using=26 npx vitest run --project worker apps/worker/test/phone-login.test.ts
# FAIL: Cannot find module '../src/login/phone.ts'
```

- [ ] **Шаг 3: Реализация**

`apps/worker/src/login/phone-client.ts` — новый файл

```ts
import { MemoryStorage, TelegramClient } from '@mtcute/node'
import type { AccountDevice } from '@workspace/db'
import { proxyTransport, type ProxyEndpoint } from '../proxies/checker.ts'
import type { SessionProfile } from '../telegram/session.ts'
import type { LoginClient } from './common.ts'
import { profileOf } from './profile.ts'

/** Where Telegram sent the login code and what «send again» would do. */
export interface SentCodeInfo {
  phoneCodeHash: string
  /** app, sms, call, email, email_required, … (mtcute's SentCodeDeliveryType) */
  deliveryType: string
  codeLength: number
  /** how a resend would deliver it; 'none' — it cannot */
  nextType: string
  /** a resend is possible after this many seconds (0 — at once) */
  timeoutSec: number
}

/** A throwaway client for one phone-number login; its session is exported and handed to the account manager. */
export interface PhoneClient extends LoginClient {
  /** the profile when Telegram authorizes at once (a future-auth token), otherwise where the code went */
  sendCode(phone: string): Promise<SentCodeInfo | SessionProfile>
  resendCode(phone: string, phoneCodeHash: string): Promise<SentCodeInfo>
  /** throws SESSION_PASSWORD_NEEDED when the account has a cloud password */
  signIn(phone: string, phoneCodeHash: string, code: string): Promise<SessionProfile>
  checkPassword(password: string): Promise<SessionProfile>
  cancelCode(phone: string, phoneCodeHash: string): Promise<void>
  passwordHint(): Promise<string | null>
}

export type PhoneClientFactory = (options: { apiId: number; apiHash: string; device: AccountDevice; proxy: ProxyEndpoint | null }) => PhoneClient

export const createMtcutePhoneClient: PhoneClientFactory = (options) => {
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
  const info = (code: { phoneCodeHash: string; type: string; length: number; nextType: string; timeout: number }): SentCodeInfo => ({
    phoneCodeHash: code.phoneCodeHash,
    deliveryType: code.type,
    codeLength: code.length,
    nextType: code.nextType,
    timeoutSec: code.timeout,
  })
  return {
    async sendCode(phone) {
      const res = await client.sendCode({ phone })
      return 'phoneCodeHash' in res ? info(res) : profileOf(res)
    },
    async resendCode(phone, phoneCodeHash) {
      return info(await client.resendCode({ phone, phoneCodeHash }))
    },
    async signIn(phone, phoneCodeHash, code) {
      return profileOf(await client.signIn({ phone, phoneCodeHash, phoneCode: code }))
    },
    async checkPassword(password) {
      return profileOf(await client.checkPassword(password))
    },
    async cancelCode(phone, phoneCodeHash) {
      await client.call({ _: 'auth.cancelCode', phoneNumber: phone, phoneCodeHash })
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

`apps/worker/src/login/phone.ts` — новый файл

```ts
import { tl } from '@mtcute/core'
import type { PhoneLoginState } from '@workspace/shared/accounts'
import { loginControlChannel, loginControlSchema, type LoginControl } from '@workspace/shared/commands'
import { parseDuration } from '@workspace/shared/duration'
import type { WorkerDeps } from '../deps.ts'
import type { SessionProfile } from '../telegram/session.ts'
import { createLoginKit } from './common.ts'
import type { PhoneClient, PhoneClientFactory, SentCodeInfo } from './phone-client.ts'

export interface PhoneStart {
  loginId: string
  /** digits only (the api normalizes it) */
  phone: string
  proxyId: string | null
  adminId: string | null
}

export interface PhoneLoginOptions {
  /** overrides telegram.qrTimeout (tests) */
  timeoutMs?: number
  /** the new account is in the database: start it */
  onAccountCreated?: (accountId: string) => Promise<void> | void
}

interface PhoneUpdate {
  deliveryType?: string
  codeLength?: number
  nextType?: string
  retryAfterSec?: number
  hint?: string
  accountId?: string
  message?: string
}

/** A refusal shown to the admin as is (the login ends). */
class LoginRefused extends Error {}

/** What Telegram (or mtcute) refused, in words for the admin. */
export function phoneLoginError(err: unknown): string {
  if (err instanceof LoginRefused) return err.message
  if (tl.RpcError.is(err)) {
    switch (err.text) {
      case 'PHONE_NUMBER_INVALID':
        return 'Неверный номер'
      case 'PHONE_NUMBER_BANNED':
        return 'Номер заблокирован Telegram'
      case 'PHONE_NUMBER_UNOCCUPIED':
        return 'На этот номер нет аккаунта Telegram — регистрация через панель не поддерживается'
      case 'FLOOD_WAIT_%d':
        return `Слишком много попыток — подождите ${Math.max(1, Math.ceil((err as tl.RpcError & { seconds?: number }).seconds! / 60))} мин`
      case 'PHONE_PASSWORD_FLOOD':
        return 'Слишком много попыток ввода пароля — подождите'
      default:
        return `Telegram отказал: ${err.code} ${err.text}`
    }
  }
  const message = err instanceof Error ? err.message : String(err)
  if (/signup is no longer supported/i.test(message)) return 'На этот номер нет аккаунта Telegram — регистрация через панель не поддерживается'
  if (/payment is required/i.test(message)) return 'Telegram требует платный вход для неофициальных приложений — войдите сначала в официальном'
  return message.slice(0, 300)
}

const isProfile = (v: SentCodeInfo | SessionProfile): v is SessionProfile => 'tgUserId' in v

/**
 * Runs one phone-number login: sends the code, takes the code, the cloud password, «send again» and cancel from
 * the login's Redis channel (never stored), publishes progress as `phone.update`, and on success saves the account
 * with its session and the cloud password that let it through.
 */
export function createPhoneLogin(deps: WorkerDeps, factory: PhoneClientFactory, options: PhoneLoginOptions = {}) {
  const { settings, bus, logger } = deps
  const kit = createLoginKit(deps)

  const update = (loginId: string, state: PhoneLoginState, extra: PhoneUpdate = {}) => bus.publish({ type: 'phone.update', loginId, state, ...extra })
  const codeInfo = (code: SentCodeInfo): PhoneUpdate => ({
    deliveryType: code.deliveryType,
    codeLength: code.codeLength,
    nextType: code.nextType,
    retryAfterSec: code.timeoutSec,
  })

  return {
    async run({ loginId, phone, proxyId, adminId }: PhoneStart): Promise<void> {
      const apiId = settings.get('telegram.own.apiId')
      const apiHash = settings.get('telegram.own.apiHash')
      if (!apiId || !apiHash) {
        await update(loginId, 'failed', { message: 'Не задан свой api_id / api_hash (Настройки → Telegram)' })
        return
      }
      const abort = new AbortController()
      const timeoutMs = options.timeoutMs ?? parseDuration(settings.get('telegram.qrTimeout'))
      const timer = setTimeout(() => abort.abort(new Error('expired')), timeoutMs)

      // messages from the admin, in order; cancel cuts through at once
      const inbox: LoginControl[] = []
      let wake: (() => void) | null = null
      const stopControl = await kit.subscribe(deps.redis, loginControlChannel(loginId), loginControlSchema, (message) => {
        if (message.type === 'cancel') abort.abort(new Error('cancelled'))
        else inbox.push(message)
        wake?.()
      })
      const next = async (): Promise<LoginControl> => {
        while (inbox.length === 0) {
          if (abort.signal.aborted) throw abort.signal.reason
          await new Promise<void>((resolve) => {
            wake = resolve
            abort.signal.addEventListener('abort', () => resolve(), { once: true })
          })
          wake = null
        }
        return inbox.shift()!
      }

      let client: PhoneClient | undefined
      let code: SentCodeInfo | undefined
      try {
        const proxy = await kit.proxyEndpoint(proxyId)
        const device = kit.device()
        client = factory({ apiId, apiHash, device, proxy })
        const phoneClient = client

        let profile: SessionProfile | undefined
        let cloudPassword: string | null = null
        const first = await phoneClient.sendCode(phone)
        if (isProfile(first)) profile = first
        else {
          code = first
          if (code.deliveryType === 'email_required') {
            throw new LoginRefused('Telegram требует привязать почту для входа — сделайте это в официальном приложении')
          }
          await update(loginId, 'code_sent', codeInfo(code))
        }

        // the code
        let needsPassword = false
        while (!profile && !needsPassword) {
          const message = await next()
          if (message.type === 'resend') {
            if (code!.nextType === 'none') continue
            code = await phoneClient.resendCode(phone, code!.phoneCodeHash)
            await update(loginId, 'code_sent', codeInfo(code))
          } else if (message.type === 'code') {
            try {
              profile = await phoneClient.signIn(phone, code!.phoneCodeHash, message.code)
            } catch (err) {
              if (tl.RpcError.is(err, 'PHONE_CODE_INVALID')) await update(loginId, 'code_invalid', codeInfo(code!))
              else if (tl.RpcError.is(err, 'PHONE_CODE_EXPIRED')) await update(loginId, 'code_expired', codeInfo(code!))
              else if (tl.RpcError.is(err, 'SESSION_PASSWORD_NEEDED')) needsPassword = true
              else throw err
            }
          }
        }

        // the cloud password
        if (!profile) {
          const hint = await phoneClient.passwordHint().catch(() => null)
          await update(loginId, 'password_needed', hint ? { hint } : {})
          while (!profile) {
            const message = await next()
            if (message.type !== 'password') continue
            try {
              profile = await phoneClient.checkPassword(message.password)
              cloudPassword = message.password
            } catch (err) {
              if (!tl.RpcError.is(err, 'PASSWORD_HASH_INVALID')) throw err
              await update(loginId, 'password_invalid', hint ? { hint } : {})
            }
          }
        }

        const result = await kit.finish({ client: phoneClient, profile, source: 'phone', proxyId, adminId, cloudPassword, device })
        client = undefined
        if ('duplicateOf' in result) {
          await update(loginId, 'failed', { message: 'Этот аккаунт уже есть в панели', accountId: result.duplicateOf })
          return
        }
        await update(loginId, 'done', { accountId: result.accountId })
        await options.onAccountCreated?.(result.accountId)
      } catch (err) {
        const reason = abort.signal.aborted ? String((abort.signal.reason as Error)?.message) : null
        if (reason === 'cancelled') {
          // let Telegram drop the pending code too
          if (client && code) await client.cancelCode(phone, code.phoneCodeHash).catch(() => {})
          await update(loginId, 'cancelled')
        } else if (reason === 'expired') await update(loginId, 'expired')
        else {
          if (!(err instanceof LoginRefused)) logger.warn({ err, loginId }, 'phone: login failed')
          await update(loginId, 'failed', { message: phoneLoginError(err) })
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

`apps/worker/src/login/profile.ts` — новый файл

```ts
import type { User } from '@mtcute/core'
import type { SessionProfile } from '../telegram/session.ts'

/** The profile fields the panel keeps, from the user a login returned. */
export function profileOf(user: User): SessionProfile {
  return {
    tgUserId: user.id,
    phone: user.phoneNumber ?? null,
    username: user.username ?? null,
    firstName: user.firstName || null,
    lastName: user.lastName ?? null,
    isPremium: user.isPremium,
    dcId: user.dcId ?? null,
  }
}
```

`apps/worker/src/main.ts` — изменения

```diff
--- a/apps/worker/src/main.ts
+++ b/apps/worker/src/main.ts
@@ -13,6 +13,8 @@ import { AccountNotRunningError, createAccountManager, type SessionFactory } fro
 import { createCodeCollector } from './codes/collector.ts'
 import { housekeeping } from './housekeeping.ts'
 import { createNotifier } from './notify/notifier.ts'
+import { createPhoneLogin } from './login/phone.ts'
+import { createMtcutePhoneClient } from './login/phone-client.ts'
 import { createMtcuteQrClient } from './qr/client.ts'
 import { createQrLogin } from './qr/login.ts'
 import { createMtcuteSession } from './telegram/mtcute-session.ts'
@@ -65,6 +67,7 @@ const codeCollector = createCodeCollector(deps, { onCode: notifier.onCode })
 const accountManager = createAccountManager(deps, sessionFactory, { onSessionStarted: codeCollector.attach, onStatusChanged: notifier.onStatusChanged })
 
 const qrLogin = createQrLogin(deps, createMtcuteQrClient, { onAccountCreated: accountManager.sync })
+const phoneLogin = createPhoneLogin(deps, createMtcutePhoneClient, { onAccountCreated: accountManager.sync })
 
 const proxyChecker = createMtcuteProxyChecker(() => ({ apiId: settings.get('telegram.desktop.apiId'), apiHash: settings.get('telegram.desktop.apiHash') }))
 const proxyHealth = createProxyHealth(deps, proxyChecker, { onDown: accountManager.onProxyDown, onUp: accountManager.onProxyUp })
@@ -76,6 +79,7 @@ const runtime = createWorkerRuntime(deps, {
     'proxy.sync': async () => syncProxyStore(deps, fetch, proxyStoreHooks),
     'account.sync': async ({ accountId }) => accountManager.sync(accountId),
     'qr.start': async (start) => qrLogin.run(start),
+    'phone.start': async (start) => phoneLogin.run(start),
     'account.stop': async ({ accountId, logout }) => accountManager.stop(accountId, logout),
     'account.sessions': async ({ accountId }) => {
       try {
```

`apps/worker/src/qr/client.ts` — изменения

```diff
--- a/apps/worker/src/qr/client.ts
+++ b/apps/worker/src/qr/client.ts
@@ -1,6 +1,7 @@
 import { MemoryStorage, TelegramClient } from '@mtcute/node'
 import type { AccountDevice } from '@workspace/db'
 import { proxyTransport, type ProxyEndpoint } from '../proxies/checker.ts'
+import { profileOf } from '../login/profile.ts'
 import type { SessionProfile } from '../telegram/session.ts'
 
 export interface QrSignInParams {
@@ -48,15 +49,7 @@ export const createMtcuteQrClient: QrClientFactory = (options) => {
         invalidPasswordCallback: params.invalidPasswordCallback,
         abortSignal: params.abortSignal,
       })
-      return {
-        tgUserId: user.id,
-        phone: user.phoneNumber ?? null,
-        username: user.username ?? null,
-        firstName: user.firstName || null,
-        lastName: user.lastName ?? null,
-        isPremium: user.isPremium,
-        dcId: user.dcId ?? null,
-      }
+      return profileOf(user)
     },
     async passwordHint() {
       const pwd = await client.call({ _: 'account.getPassword' })
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
feat(worker): login by phone number — code (resend, expiry), cloud password, cancel, timeout, Telegram refusals in words; shared profile mapping
MSG
```

---

### Task 4: API: вход по номеру

`POST /phone-login`:
- нужен свой api_id (иначе 409 `own_api_missing`);
- номер нормализуется; прокси — только свободный, «напрямую» — только явным `proxyId: null`;
- отправляет `phone.start`, отвечает `{loginId}`.

Код, пароль, «ещё раз» и отмена публикуются в канал входа. Маршруты кода и пароля пишутся в аудит без тела.

В тесте код намеренно не совпадает с подстрокой номера: иначе проверка «кода нет в аудите» ловила бы номер из аудита старта.

**Files:**
- Modify: `apps/api/src/app.ts`
- Create: `apps/api/src/routes/phone-login.ts`
- Test: `apps/api/test/phone-login.test.ts`

**Interfaces:**
- Consumes: `startPhoneLoginInput`, `phoneCodeInput`, `loginControlChannel` (задача 1); `isProxyFree` (план 2).
- Produces:
  - `apps/api/src/routes/phone-login.ts`: `phoneLoginRoutes`

- [ ] **Шаг 1: Написать падающий тест**

`apps/api/test/phone-login.test.ts` — новый файл

```ts
import { accounts, auditLog, proxies } from '@workspace/db'
import { createRedis } from '@workspace/server'
import { loginControlChannel } from '@workspace/shared/commands'
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

describe('phone login api', () => {
  it('needs the own api_id, a real phone number and a free proxy', async () => {
    const start = (body: unknown) => send(ta.app, '/api/phone-login', { cookie, body })
    const noApi = await start({ phone: '+7 700 123 45 67', proxyId: null })
    expect(noApi.status).toBe(409)
    expect(await noApi.json()).toMatchObject({ error: 'own_api_missing' })

    await ta.deps.settings.update({ 'telegram.own.apiId': 123456, 'telegram.own.apiHash': '0123456789abcdef0123456789abcdef' }, { adminId: null })
    expect((await start({ phone: 'call me', proxyId: null })).status).toBe(400)
    const [dead] = await ta.t.db.insert(proxies).values({ source: 'manual', type: 'socks5', host: '10.5.5.1', port: 1080, status: 'dead' }).returning()
    const busy = await start({ phone: '+77001234567', proxyId: dead!.id })
    expect(busy.status).toBe(409)
    expect(await busy.json()).toMatchObject({ error: 'proxy_unavailable' })
  })

  it('starts a login on the worker and passes code, password, resend and cancel over pub/sub — never into the audit log', async () => {
    await ta.deps.settings.update({ 'telegram.own.apiId': 123456, 'telegram.own.apiHash': '0123456789abcdef0123456789abcdef' }, { adminId: null })
    ta.commands.sent = []
    const res = await send(ta.app, '/api/phone-login', { cookie, body: { phone: '+7 (700) 123-45-67', proxyId: null } })
    expect(res.status).toBe(201)
    const { loginId } = (await res.json()) as { loginId: string }
    expect(ta.commands.sent).toEqual([{ type: 'phone.start', loginId, phone: '77001234567', proxyId: null, adminId: expect.any(String) }])

    const sub = createRedis(inject('redisUrl'), 'phone-test-sub')
    const received: unknown[] = []
    try {
      await sub.subscribe(loginControlChannel(loginId))
      sub.on('message', (_c: string, m: string) => received.push(JSON.parse(m)))
      expect((await send(ta.app, `/api/phone-login/${loginId}/code`, { cookie, body: { code: '58 093' } })).status).toBe(202)
      expect((await send(ta.app, `/api/phone-login/${loginId}/resend`, { cookie, body: {} })).status).toBe(202)
      expect((await send(ta.app, `/api/phone-login/${loginId}/password`, { cookie, body: { password: 's3cret-cloud' } })).status).toBe(202)
      expect((await send(ta.app, `/api/phone-login/${loginId}`, { cookie, method: 'DELETE' })).status).toBe(204)
      expect((await send(ta.app, `/api/phone-login/${loginId}/code`, { cookie, body: { code: 'abc' } })).status).toBe(400)
      await vi.waitFor(() =>
        expect(received).toEqual([{ type: 'code', code: '58093' }, { type: 'resend' }, { type: 'password', password: 's3cret-cloud' }, { type: 'cancel' }]),
      )
    } finally {
      await sub.quit()
    }
    const audit = JSON.stringify(await ta.t.db.select().from(auditLog))
    expect(audit).not.toContain('s3cret-cloud')
    expect(audit).not.toContain('58093')
    expect(await ta.t.db.select().from(accounts)).toHaveLength(0)
  })
})
```

- [ ] **Шаг 2: Убедиться, что тест падает**

```bash
fnm exec --using=26 npx vitest run --project api apps/api/test/phone-login.test.ts
# FAIL: expected 404 to be 409 — маршрутов нет
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
+import { phoneLoginRoutes } from './routes/phone-login.ts'
 import { qrRoutes } from './routes/qr.ts'
 import { settingsRoutes } from './routes/settings.ts'
 import { WorkerTimeoutError } from '@workspace/server'
@@ -71,6 +72,7 @@ export function createApp(deps: AppDeps): Hono<AppEnv> {
   api.route('/', importRoutes)
   api.route('/', accountRoutes)
   api.route('/', qrRoutes)
+  api.route('/', phoneLoginRoutes)
   api.route('/', codeRoutes)
   api.route('/', auditRoutes)
   api.route('/', eventRoutes)
```

`apps/api/src/routes/phone-login.ts` — новый файл

```ts
import { randomUUID } from 'node:crypto'
import { zValidator } from '@hono/zod-validator'
import { phoneCodeInput, qrPasswordInput, startPhoneLoginInput } from '@workspace/shared/accounts'
import { loginControlChannel, type LoginControl } from '@workspace/shared/commands'
import { Hono } from 'hono'
import { z } from 'zod'
import type { AppEnv } from '../deps.ts'
import { DomainError } from '../lib/errors.ts'
import { audited } from '../middleware/audit.ts'
import { isProxyFree } from '../services/accounts.ts'
import { validationHook } from './validation.ts'

const idParam = z.object({ id: z.uuid() })

/** Progress comes back as `phone.update` events on the live stream. */
export const phoneLoginRoutes = new Hono<AppEnv>()
  .post('/phone-login', audited('account.phone.start'), zValidator('json', startPhoneLoginInput, validationHook), async (c) => {
    const { settings, db, commands } = c.get('deps')
    if (!settings.get('telegram.own.apiId') || !settings.get('telegram.own.apiHash')) {
      throw new DomainError(409, 'own_api_missing', 'Для входа по номеру нужен свой api_id и api_hash (Настройки → Telegram)')
    }
    const { phone, proxyId } = c.req.valid('json')
    if (proxyId && !(await isProxyFree(db, proxyId))) throw new DomainError(409, 'proxy_unavailable', 'Прокси не работает, отключён или уже занят')
    const loginId = randomUUID()
    await commands.send({ type: 'phone.start', loginId, phone, proxyId, adminId: c.get('admin')?.id ?? null })
    c.set('audit', { ...c.get('audit'), targetType: 'phone_login', targetId: loginId })
    return c.json({ loginId }, 201)
  })
  // the code and the cloud password go straight to the worker over pub/sub: not stored, not in the audit log
  .post('/phone-login/:id/code', audited('account.phone.code', { payload: null, target: ['phone_login', 'id'] }), zValidator('param', idParam, validationHook), zValidator('json', phoneCodeInput, validationHook), async (c) => {
    await publish(c, c.req.valid('param').id, { type: 'code', code: c.req.valid('json').code })
    return c.body(null, 202)
  })
  .post('/phone-login/:id/password', audited('account.phone.password', { payload: null, target: ['phone_login', 'id'] }), zValidator('param', idParam, validationHook), zValidator('json', qrPasswordInput, validationHook), async (c) => {
    await publish(c, c.req.valid('param').id, { type: 'password', password: c.req.valid('json').password })
    return c.body(null, 202)
  })
  .post('/phone-login/:id/resend', audited('account.phone.resend', { target: ['phone_login', 'id'] }), zValidator('param', idParam, validationHook), async (c) => {
    await publish(c, c.req.valid('param').id, { type: 'resend' })
    return c.body(null, 202)
  })
  .delete('/phone-login/:id', audited('account.phone.cancel', { target: ['phone_login', 'id'] }), zValidator('param', idParam, validationHook), async (c) => {
    await publish(c, c.req.valid('param').id, { type: 'cancel' })
    return c.body(null, 204)
  })

async function publish(c: { get: (key: 'deps') => AppEnv['Variables']['deps'] }, loginId: string, message: LoginControl): Promise<void> {
  await c.get('deps').redis.publish(loginControlChannel(loginId), JSON.stringify(message))
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
feat(api): phone-number login — start (own api_id, free proxy), code, cloud password, resend, cancel over pub/sub; secrets kept out of the audit log
MSG
```

---

### Task 5: Воркер: облачный пароль подключённых аккаунтов

`TelegramSession` получает методы 2FA, реализованные на mtcute: состояние, адрес почты восстановления (он же проверка пароля через `account.getPasswordSettings`), установка или смена, подтверждение и отмена почты. `EMAIL_UNCONFIRMED_<длина>` означает, что пароль уже стоит, а почта ждёт код. Менеджер отдаёт клиента через `runningSession`.

Сервис `createCloudPassword`:
- **`info`** — состояние. Сохранённый пароль, который Telegram больше не принимает или которого уже нет, забывается.
- **`verify`** — запоминает пароль только после того, как Telegram его принял.
- **`set`** — для смены берёт введённый текущий пароль, иначе сохранённый. Отказ на сохранённом — `stale_password`, пароль забывается; на введённом — `wrong_password`. Новый пароль сохраняется сразу, даже пока почта ждёт код.
- **`email`** — подтвердить, отправить ещё раз, отменить.
- **Ошибки:** «свежая» сессия — `too_fresh` с секундами ожидания; неверная почта, неверный или просроченный код — каждый своим кодом ошибки.

Фейк сессии ведёт 2FA-состояние по сценарию.

**Files:**
- Create: `apps/worker/src/accounts/cloud-password.ts`
- Modify: `apps/worker/src/accounts/manager.ts`
- Modify: `apps/worker/src/main.ts`
- Modify: `apps/worker/src/telegram/mtcute-session.ts`
- Modify: `apps/worker/src/telegram/session.ts`
- Test: `apps/worker/test/cloud-password.test.ts`
- Test (modify): `apps/worker/test/fake-session.ts`

**Interfaces:**
- Consumes: `createAccountManager` (план 2, + `runningSession`); команды `account.password.*` и типы `CloudPassword*Result` (задача 1).
- Produces:
  - `apps/worker/src/accounts/cloud-password.ts`: `interface SetCloudPassword`; `createCloudPassword(deps: WorkerDeps, runningSession: (accountId: string) => TelegramSession | undefined)`; `type CloudPassword`
  - `apps/worker/src/telegram/session.ts`: `interface PasswordState`; `interface SetPasswordParams`; `interface EmailCodeInfo`

- [ ] **Шаг 1: Написать падающий тест**

`apps/worker/test/cloud-password.test.ts` — новый файл

```ts
import { accounts, eq } from '@workspace/db'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createAccountManager } from '../src/accounts/manager.ts'
import { createCloudPassword } from '../src/accounts/cloud-password.ts'
import { fakeFactory, type FakeSession } from './fake-session.ts'
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
})

const device = { deviceModel: 'Desktop', systemVersion: 'Windows 11 x64', appVersion: '7.2.9 x64', langCode: 'ru' }
let nextUser = 71000
const enc = (v: string) => w.deps.cipher.encrypt(v)

/** A connected account whose Telegram side is `script`, and the service under test. */
async function connected(script: (s: FakeSession) => void = () => {}, stored: string | null = null) {
  const [a] = await w.t.db
    .insert(accounts)
    .values({ tgUserId: nextUser++, source: 'tdata', clientProfile: 'desktop', device, connectionMode: 'direct', cloudPasswordEnc: stored ? enc(stored) : null })
    .returning()
  const fake = fakeFactory(script)
  const manager = createAccountManager(w.deps, fake.factory, {}, { jitterMs: 0 })
  await manager.sync(a!.id)
  const service = createCloudPassword(w.deps, manager.runningSession)
  const storedNow = async () => {
    const [row] = await w.t.db.select({ v: accounts.cloudPasswordEnc }).from(accounts).where(eq(accounts.id, a!.id))
    return row!.v ? w.deps.cipher.decrypt(row!.v) : null
  }
  return { id: a!.id, session: fake.last(), manager, service, storedNow }
}

describe('cloud password', () => {
  it('reports the state; the recovery email only when the panel knows the password', async () => {
    const unknown = await connected((s) => Object.assign(s.twoFa, { password: 'p1', hint: 'кот', email: 'me@example.com' }))
    expect(await unknown.service.info(unknown.id)).toEqual({
      info: { hasPassword: true, hint: 'кот', known: false, hasRecovery: true, recoveryEmail: null, unconfirmedEmailPattern: null, pendingResetAt: null },
    })
    const known = await connected((s) => Object.assign(s.twoFa, { password: 'p1', email: 'me@example.com', pendingResetAt: new Date('2026-10-10T00:00:00Z') }), 'p1')
    expect(await known.service.info(known.id)).toMatchObject({ info: { known: true, recoveryEmail: 'me@example.com', pendingResetAt: '2026-10-10T00:00:00.000Z' } })
    await unknown.manager.stopAll()
    await known.manager.stopAll()
    expect(await known.service.info(known.id)).toEqual({ error: 'not_running' })
  })

  it('forgets a stored password Telegram no longer accepts', async () => {
    const changed = await connected((s) => Object.assign(s.twoFa, { password: 'changed-elsewhere' }), 'old')
    expect(await changed.service.info(changed.id)).toMatchObject({ info: { hasPassword: true, known: false } })
    expect(await changed.storedNow()).toBeNull()
    const removed = await connected(() => {}, 'old')
    expect(await removed.service.info(removed.id)).toMatchObject({ info: { hasPassword: false, known: false } })
    expect(await removed.storedNow()).toBeNull()
    await changed.manager.stopAll()
    await removed.manager.stopAll()
  })

  it('remembers the current password only once Telegram confirms it', async () => {
    const a = await connected((s) => Object.assign(s.twoFa, { password: 'p1' }))
    expect(await a.service.verify(a.id, enc('wrong'))).toEqual({ error: 'wrong_password' })
    expect(await a.storedNow()).toBeNull()
    expect(await a.service.verify(a.id, enc('p1'))).toEqual({ ok: true })
    expect(await a.storedNow()).toBe('p1')
    await a.manager.stopAll()
  })

  it('sets a first password and changes it with the stored one, keeping the new one', async () => {
    const a = await connected()
    expect(await a.service.set(a.id, { currentPasswordEnc: null, newPasswordEnc: enc('first'), hint: 'кот', email: null })).toEqual({ ok: true })
    expect(a.session.twoFa).toMatchObject({ password: 'first', hint: 'кот' })
    expect(await a.storedNow()).toBe('first')
    expect(await a.service.set(a.id, { currentPasswordEnc: null, newPasswordEnc: enc('second'), hint: null, email: null })).toEqual({ ok: true })
    expect(a.session.setPassword).toHaveBeenLastCalledWith({ current: 'first', next: 'second', hint: null, email: null })
    expect(await a.storedNow()).toBe('second')
    await a.manager.stopAll()
  })

  it('needs the current password when the panel does not know it, and says which one was wrong', async () => {
    const a = await connected((s) => Object.assign(s.twoFa, { password: 'p1' }))
    expect(await a.service.set(a.id, { currentPasswordEnc: null, newPasswordEnc: enc('n'), hint: null, email: null })).toEqual({ error: 'password_unknown' })
    expect(await a.service.set(a.id, { currentPasswordEnc: enc('nope'), newPasswordEnc: enc('n'), hint: null, email: null })).toEqual({ error: 'wrong_password' })
    const stale = await connected((s) => Object.assign(s.twoFa, { password: 'p2' }), 'outdated')
    // the stored one is tried first; when it fails it is forgotten
    expect(await stale.service.set(stale.id, { currentPasswordEnc: null, newPasswordEnc: enc('n'), hint: null, email: null })).toEqual({ error: 'stale_password' })
    expect(await stale.storedNow()).toBeNull()
    await a.manager.stopAll()
    await stale.manager.stopAll()
  })

  it('reports how long Telegram makes a fresh session wait', async () => {
    const a = await connected((s) => (s.twoFa.tooFreshSec = 86_400))
    expect(await a.service.set(a.id, { currentPasswordEnc: null, newPasswordEnc: enc('n'), hint: null, email: null })).toEqual({ error: 'too_fresh', retryAfterSec: 86_400 })
    await a.manager.stopAll()
  })

  it('asks for the code from the recovery email; confirms, resends or drops it', async () => {
    const a = await connected()
    expect(await a.service.set(a.id, { currentPasswordEnc: null, newPasswordEnc: enc('p'), hint: null, email: 'not-an-email' })).toEqual({ error: 'email_invalid' })
    expect(await a.service.set(a.id, { currentPasswordEnc: null, newPasswordEnc: enc('p'), hint: null, email: 'me@example.com' })).toEqual({
      emailCodeNeeded: { pattern: 'm***@example.com', length: 6 },
    })
    // the new password is in force already: the panel keeps it
    expect(await a.storedNow()).toBe('p')
    expect(await a.service.email(a.id, 'confirm', enc('000000'))).toEqual({ error: 'code_invalid' })
    expect(await a.service.email(a.id, 'resend', null)).toEqual({ ok: true })
    expect(await a.service.email(a.id, 'confirm', enc('424242'))).toEqual({ ok: true })
    expect(await a.service.info(a.id)).toMatchObject({ info: { known: true, hasRecovery: true, recoveryEmail: 'me@example.com' } })

    const b = await connected()
    await b.service.set(b.id, { currentPasswordEnc: null, newPasswordEnc: enc('p'), hint: null, email: 'me@example.com' })
    expect(await b.service.email(b.id, 'cancel', null)).toEqual({ ok: true })
    expect(await b.service.info(b.id)).toMatchObject({ info: { hasPassword: true, hasRecovery: false, unconfirmedEmailPattern: null } })
    await a.manager.stopAll()
    await b.manager.stopAll()
  })
})
```

`apps/worker/test/fake-session.ts` — изменения

```diff
--- a/apps/worker/test/fake-session.ts
+++ b/apps/worker/test/fake-session.ts
@@ -3,7 +3,7 @@ import type { AccountSessionDto } from '@workspace/shared/accounts'
 import { vi } from 'vitest'
 import type { AccountRow, SessionFactory } from '../src/accounts/manager.ts'
 import type { ProxyEndpoint } from '../src/proxies/checker.ts'
-import type { FreezeInfo, IncomingMessage, SessionProfile, TelegramSession } from '../src/telegram/session.ts'
+import type { FreezeInfo, IncomingMessage, PasswordState, SessionProfile, SetPasswordParams, TelegramSession } from '../src/telegram/session.ts'
 
 export const rpcError = (code: number, text: string) => new tl.RpcError(code, text)
 
@@ -66,6 +66,48 @@ export class FakeSession implements TelegramSession {
     this.rejectStart?.(new Error('Session is reset'))
   })
 
+  /** the account's cloud password as Telegram keeps it; the recovery email waits for code 424242 */
+  twoFa = {
+    password: null as string | null,
+    hint: null as string | null,
+    email: null as string | null,
+    pending: null as { email: string; code: string } | null,
+    pendingResetAt: null as Date | null,
+    tooFreshSec: 0,
+  }
+  passwordState = vi.fn(
+    async (): Promise<PasswordState> => ({
+      hasPassword: this.twoFa.password !== null,
+      hint: this.twoFa.hint,
+      hasRecovery: this.twoFa.email !== null,
+      unconfirmedEmailPattern: this.twoFa.pending ? 'm***@example.com' : null,
+      pendingResetAt: this.twoFa.pendingResetAt,
+    }),
+  )
+  recoveryEmail = vi.fn(async (password: string) => {
+    if (password !== this.twoFa.password) throw rpcError(400, 'PASSWORD_HASH_INVALID')
+    return this.twoFa.email
+  })
+  setPassword = vi.fn(async (p: SetPasswordParams) => {
+    if (this.twoFa.tooFreshSec) throw Object.assign(rpcError(400, 'SESSION_TOO_FRESH_%d'), { seconds: this.twoFa.tooFreshSec })
+    if (this.twoFa.password !== null && p.current !== this.twoFa.password) throw rpcError(400, 'PASSWORD_HASH_INVALID')
+    if (p.email !== null && !p.email.includes('@')) throw rpcError(400, 'EMAIL_INVALID')
+    this.twoFa.password = p.next
+    this.twoFa.hint = p.hint
+    if (p.email === null) return null
+    this.twoFa.pending = { email: p.email, code: '424242' }
+    return { emailCodeLength: 6, emailPattern: 'm***@example.com' }
+  })
+  confirmPasswordEmail = vi.fn(async (code: string) => {
+    if (!this.twoFa.pending || code !== this.twoFa.pending.code) throw rpcError(400, 'CODE_INVALID')
+    this.twoFa.email = this.twoFa.pending.email
+    this.twoFa.pending = null
+  })
+  resendPasswordEmail = vi.fn(async () => {})
+  cancelPasswordEmail = vi.fn(async () => {
+    this.twoFa.pending = null
+  })
+
   emitMessage(m: IncomingMessage) {
     for (const l of this.messageListeners) l(m)
   }
```

- [ ] **Шаг 2: Убедиться, что тест падает**

```bash
fnm exec --using=26 npx vitest run --project worker apps/worker/test/cloud-password.test.ts
# FAIL: Cannot find module '../src/accounts/cloud-password.ts'
```

- [ ] **Шаг 3: Реализация**

`apps/worker/src/accounts/cloud-password.ts` — новый файл

```ts
import { tl } from '@mtcute/core'
import { accounts, eq } from '@workspace/db'
import type {
  CloudPasswordEmailResult,
  CloudPasswordError,
  CloudPasswordInfoResult,
  CloudPasswordSetResult,
  CloudPasswordVerifyResult,
} from '@workspace/shared/commands'
import type { WorkerDeps } from '../deps.ts'
import type { TelegramSession } from '../telegram/session.ts'

export interface SetCloudPassword {
  /** ciphertext; null — use the password the panel knows */
  currentPasswordEnc: string | null
  newPasswordEnc: string
  hint: string | null
  email: string | null
}

const WRONG = 'PASSWORD_HASH_INVALID'

/**
 * The cloud (2FA) password of connected accounts: what Telegram says about it, checking and remembering the
 * current one, setting or changing it (with an optional recovery email and its code). Secrets arrive encrypted
 * and are stored encrypted — written only after Telegram accepted them.
 */
export function createCloudPassword(deps: WorkerDeps, runningSession: (accountId: string) => TelegramSession | undefined) {
  const { db, cipher, logger } = deps

  async function stored(accountId: string): Promise<string | null> {
    const [row] = await db.select({ enc: accounts.cloudPasswordEnc }).from(accounts).where(eq(accounts.id, accountId))
    return row?.enc ? cipher.decrypt(row.enc) : null
  }
  const remember = (accountId: string, password: string | null) =>
    db
      .update(accounts)
      .set({ cloudPasswordEnc: password === null ? null : cipher.encrypt(password) })
      .where(eq(accounts.id, accountId))

  /** Telegram's refusals in the shape the api expects; anything unforeseen is logged and passed on as text. */
  function failure(err: unknown, accountId: string): CloudPasswordError {
    if (tl.RpcError.is(err)) {
      const seconds = (err as tl.RpcError & { seconds?: number }).seconds
      switch (err.text) {
        case 'SESSION_TOO_FRESH_%d':
        case 'PASSWORD_TOO_FRESH_%d':
          return { error: 'too_fresh', retryAfterSec: seconds ?? 0 }
        case 'EMAIL_INVALID':
          return { error: 'email_invalid' }
        case 'CODE_INVALID':
          return { error: 'code_invalid' }
        case 'EMAIL_HASH_EXPIRED':
          return { error: 'code_expired' }
      }
    }
    logger.warn({ err, accountId }, 'cloud password: operation failed')
    return { error: 'other', message: tl.RpcError.is(err) ? `${err.code} ${err.text}` : err instanceof Error ? err.message.slice(0, 300) : String(err) }
  }

  return {
    async info(accountId: string): Promise<CloudPasswordInfoResult> {
      const session = runningSession(accountId)
      if (!session) return { error: 'not_running' }
      try {
        const state = await session.passwordState()
        let password = await stored(accountId)
        let recoveryEmail: string | null = null
        if (password !== null && !state.hasPassword) {
          // removed outside the panel
          await remember(accountId, null)
          password = null
        }
        if (password !== null) {
          try {
            recoveryEmail = await session.recoveryEmail(password)
          } catch (err) {
            if (!tl.RpcError.is(err, WRONG)) throw err
            // changed outside the panel: the stored one is useless now
            await remember(accountId, null)
            password = null
          }
        }
        return {
          info: {
            hasPassword: state.hasPassword,
            hint: state.hint,
            known: password !== null,
            hasRecovery: state.hasRecovery,
            recoveryEmail,
            unconfirmedEmailPattern: state.unconfirmedEmailPattern,
            pendingResetAt: state.pendingResetAt?.toISOString() ?? null,
          },
        }
      } catch (err) {
        return failure(err, accountId)
      }
    },

    async verify(accountId: string, passwordEnc: string): Promise<CloudPasswordVerifyResult> {
      const session = runningSession(accountId)
      if (!session) return { error: 'not_running' }
      const password = cipher.decrypt(passwordEnc)
      try {
        // getPasswordSettings needs the right password: a cheap check with no side effect
        await session.recoveryEmail(password)
      } catch (err) {
        if (tl.RpcError.is(err, WRONG)) return { error: 'wrong_password' }
        return failure(err, accountId)
      }
      await remember(accountId, password)
      return { ok: true }
    },

    async set(accountId: string, input: SetCloudPassword): Promise<CloudPasswordSetResult> {
      const session = runningSession(accountId)
      if (!session) return { error: 'not_running' }
      const next = cipher.decrypt(input.newPasswordEnc)
      const given = input.currentPasswordEnc === null ? null : cipher.decrypt(input.currentPasswordEnc)
      try {
        const state = await session.passwordState()
        const current = state.hasPassword ? (given ?? (await stored(accountId))) : null
        if (state.hasPassword && current === null) return { error: 'password_unknown' }
        let emailCode
        try {
          emailCode = await session.setPassword({ current, next, hint: input.hint, email: input.email })
        } catch (err) {
          if (!tl.RpcError.is(err, WRONG)) throw err
          if (given !== null) return { error: 'wrong_password' }
          await remember(accountId, null)
          return { error: 'stale_password' }
        }
        // in force now, even while a recovery email waits for its code
        await remember(accountId, next)
        return emailCode ? { emailCodeNeeded: { pattern: emailCode.emailPattern, length: emailCode.emailCodeLength } } : { ok: true }
      } catch (err) {
        return failure(err, accountId)
      }
    },

    async email(accountId: string, action: 'confirm' | 'resend' | 'cancel', codeEnc: string | null): Promise<CloudPasswordEmailResult> {
      const session = runningSession(accountId)
      if (!session) return { error: 'not_running' }
      try {
        if (action === 'confirm') await session.confirmPasswordEmail(codeEnc === null ? '' : cipher.decrypt(codeEnc))
        else if (action === 'resend') await session.resendPasswordEmail()
        else await session.cancelPasswordEmail()
        return { ok: true }
      } catch (err) {
        return failure(err, accountId)
      }
    },
  }
}

export type CloudPassword = ReturnType<typeof createCloudPassword>
```

`apps/worker/src/accounts/manager.ts` — изменения

```diff
--- a/apps/worker/src/accounts/manager.ts
+++ b/apps/worker/src/accounts/manager.ts
@@ -39,6 +39,8 @@ export interface AccountManager {
   sessions(accountId: string): Promise<AccountSessionDto[]>
   terminateSession(accountId: string, hash: string): Promise<void>
   isRunning(accountId: string): boolean
+  /** the live client of a connected account (cloud password operations), if any */
+  runningSession(accountId: string): TelegramSession | undefined
   stopAll(): Promise<void>
 }
 
@@ -319,6 +321,7 @@ export function createAccountManager(deps: WorkerDeps, factory: SessionFactory,
       await session.terminateSession(hash)
     },
     isRunning: (accountId) => running.has(accountId),
+    runningSession: (accountId) => running.get(accountId),
     async stopAll() {
       shuttingDown = true
       for (const id of [...retries.keys()]) clearRetry(id)
```

`apps/worker/src/main.ts` — изменения

```diff
--- a/apps/worker/src/main.ts
+++ b/apps/worker/src/main.ts
@@ -13,6 +13,7 @@ import { AccountNotRunningError, createAccountManager, type SessionFactory } fro
 import { createCodeCollector } from './codes/collector.ts'
 import { housekeeping } from './housekeeping.ts'
 import { createNotifier } from './notify/notifier.ts'
+import { createCloudPassword } from './accounts/cloud-password.ts'
 import { createPhoneLogin } from './login/phone.ts'
 import { createMtcutePhoneClient } from './login/phone-client.ts'
 import { createMtcuteQrClient } from './qr/client.ts'
@@ -68,6 +69,7 @@ const accountManager = createAccountManager(deps, sessionFactory, { onSessionSta
 
 const qrLogin = createQrLogin(deps, createMtcuteQrClient, { onAccountCreated: accountManager.sync })
 const phoneLogin = createPhoneLogin(deps, createMtcutePhoneClient, { onAccountCreated: accountManager.sync })
+const cloudPassword = createCloudPassword(deps, accountManager.runningSession)
 
 const proxyChecker = createMtcuteProxyChecker(() => ({ apiId: settings.get('telegram.desktop.apiId'), apiHash: settings.get('telegram.desktop.apiHash') }))
 const proxyHealth = createProxyHealth(deps, proxyChecker, { onDown: accountManager.onProxyDown, onUp: accountManager.onProxyUp })
@@ -80,6 +82,10 @@ const runtime = createWorkerRuntime(deps, {
     'account.sync': async ({ accountId }) => accountManager.sync(accountId),
     'qr.start': async (start) => qrLogin.run(start),
     'phone.start': async (start) => phoneLogin.run(start),
+    'account.password.info': async ({ accountId }) => cloudPassword.info(accountId),
+    'account.password.verify': async ({ accountId, passwordEnc }) => cloudPassword.verify(accountId, passwordEnc),
+    'account.password.set': async ({ accountId, ...input }) => cloudPassword.set(accountId, input),
+    'account.password.email': async ({ accountId, action, codeEnc }) => cloudPassword.email(accountId, action, codeEnc),
     'account.stop': async ({ accountId, logout }) => accountManager.stop(accountId, logout),
     'account.sessions': async ({ accountId }) => {
       try {
```

`apps/worker/src/telegram/mtcute-session.ts` — изменения

```diff
--- a/apps/worker/src/telegram/mtcute-session.ts
+++ b/apps/worker/src/telegram/mtcute-session.ts
@@ -116,6 +116,54 @@ export function createMtcuteSession(options: MtcuteSessionOptions): TelegramSess
     async terminateSession(hash) {
       await client.call({ _: 'account.resetAuthorization', hash: Long.fromString(hash) })
     },
+    async passwordState() {
+      const pwd = await client.call({ _: 'account.getPassword' })
+      return {
+        hasPassword: Boolean(pwd.hasPassword),
+        hint: pwd.hint ?? null,
+        hasRecovery: Boolean(pwd.hasRecovery),
+        unconfirmedEmailPattern: pwd.emailUnconfirmedPattern ?? null,
+        pendingResetAt: pwd.pendingResetDate ? new Date(pwd.pendingResetDate * 1000) : null,
+      }
+    },
+    async recoveryEmail(password) {
+      const pwd = await client.call({ _: 'account.getPassword' })
+      const settings = await client.call({ _: 'account.getPasswordSettings', password: await client.computeSrpParams(pwd, password) })
+      return settings.email ?? null
+    },
+    async setPassword({ current, next, hint, email }) {
+      const pwd = await client.call({ _: 'account.getPassword' })
+      const algo = pwd.newAlgo
+      try {
+        await client.call({
+          _: 'account.updatePasswordSettings',
+          password: current === null ? { _: 'inputCheckPasswordEmpty' } : await client.computeSrpParams(pwd, current),
+          newSettings: {
+            _: 'account.passwordInputSettings',
+            newAlgo: algo,
+            newPasswordHash: await client.computeNewPasswordHash(algo, next),
+            hint: hint ?? '',
+            ...(email !== null ? { email } : {}),
+          },
+        })
+        return null
+      } catch (err) {
+        // the password is set; the recovery email waits for the code (EMAIL_UNCONFIRMED_<code length>)
+        if (!tl.RpcError.is(err, 'EMAIL_UNCONFIRMED_%d')) throw err
+        const length = /EMAIL_UNCONFIRMED_(\d+)/.exec(err.message)?.[1]
+        const after = await client.call({ _: 'account.getPassword' })
+        return { emailCodeLength: length ? Number(length) : null, emailPattern: after.emailUnconfirmedPattern ?? null }
+      }
+    },
+    async confirmPasswordEmail(code) {
+      await client.verifyPasswordEmail(code)
+    },
+    async resendPasswordEmail() {
+      await client.resendPasswordEmail()
+    },
+    async cancelPasswordEmail() {
+      await client.cancelPasswordEmail()
+    },
     async logOut() {
       await client.logOut()
     },
```

`apps/worker/src/telegram/session.ts` — изменения

```diff
--- a/apps/worker/src/telegram/session.ts
+++ b/apps/worker/src/telegram/session.ts
@@ -25,6 +25,30 @@ export interface IncomingMessage {
   markup: unknown
 }
 
+/** What Telegram tells anyone about the account's cloud password (account.getPassword). */
+export interface PasswordState {
+  hasPassword: boolean
+  hint: string | null
+  hasRecovery: boolean
+  unconfirmedEmailPattern: string | null
+  pendingResetAt: Date | null
+}
+
+export interface SetPasswordParams {
+  /** null when the account has no password yet */
+  current: string | null
+  next: string
+  hint: string | null
+  /** a new recovery email; null keeps the current one */
+  email: string | null
+}
+
+/** The recovery email waits for the code Telegram mailed. */
+export interface EmailCodeInfo {
+  emailCodeLength: number | null
+  emailPattern: string | null
+}
+
 /** One live account client. The worker talks to Telegram only through this, so tests can fake it. */
 export interface TelegramSession {
   /** connect (importing the tdata session the first time) and return who we are */
@@ -40,6 +64,14 @@ export interface TelegramSession {
   onError(listener: (err: unknown) => void): void
   sessions(): Promise<AccountSessionDto[]>
   terminateSession(hash: string): Promise<void>
+  passwordState(): Promise<PasswordState>
+  /** the confirmed recovery email; throws PASSWORD_HASH_INVALID when `password` is wrong (so it also checks it) */
+  recoveryEmail(password: string): Promise<string | null>
+  /** sets or changes the cloud password; tells when the new recovery email waits for its code */
+  setPassword(params: SetPasswordParams): Promise<EmailCodeInfo | null>
+  confirmPasswordEmail(code: string): Promise<void>
+  resendPasswordEmail(): Promise<void>
+  cancelPasswordEmail(): Promise<void>
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
feat(worker): cloud password of connected accounts — state with the recovery email, verify and remember the current one, set or change (stored current first, stale ones forgotten), recovery email code, too-fresh sessions
MSG
```

---

### Task 6: API: облачный пароль

Маршруты:
- `GET …/info` — состояние;
- `GET …/cloud-password` — показ сохранённого пароля, пишется в аудит;
- `POST …/verify`;
- `PUT …/cloud-password` — ответ `{ok}` или `{emailCodeNeeded}`;
- `POST …/email`.

Пароли и код из письма шифруются перед постановкой задачи: в Redis только шифротекст. Аудит — без тела запроса. Отказы воркера переводятся в `DomainError` с сообщениями из спеки; срок ожидания `too_fresh` — в часах.

**Files:**
- Modify: `apps/api/src/app.ts`
- Create: `apps/api/src/routes/cloud-password.ts`
- Test: `apps/api/test/cloud-password.test.ts`

**Interfaces:**
- Consumes: `setCloudPasswordInput`, `verifyCloudPasswordInput`, `cloudPasswordEmailInput`, `CloudPassword*Result` (задача 1); `getAccount` (план 2).
- Produces:
  - `apps/api/src/routes/cloud-password.ts`: `cloudPasswordRoutes`

- [ ] **Шаг 1: Написать падающий тест**

`apps/api/test/cloud-password.test.ts` — новый файл

```ts
import { accounts, auditLog, desc, eq } from '@workspace/db'
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
  ta.commands.sent = []
  ta.commands.respond = () => null
})

const device = { deviceModel: 'Desktop', systemVersion: 'Windows 11 x64', appVersion: '7.2.9 x64', langCode: 'ru' }
let user = 300
const insertAccount = async (values: Partial<typeof accounts.$inferInsert> = {}) =>
  (await ta.t.db.insert(accounts).values({ tgUserId: user++, source: 'tdata', clientProfile: 'desktop', device, connectionMode: 'direct', status: 'active', ...values }).returning())[0]!
const json = async <T,>(res: Response) => (await res.json()) as T
const lastAudit = async (action: string) => (await ta.t.db.select().from(auditLog).where(eq(auditLog.action, action)).orderBy(desc(auditLog.id)).limit(1))[0]

describe('cloud password api', () => {
  it('passes the state through from the worker', async () => {
    const a = await insertAccount()
    const info = { hasPassword: true, hint: 'кот', known: false, hasRecovery: true, recoveryEmail: null, unconfirmedEmailPattern: null, pendingResetAt: null }
    ta.commands.respond = (c: WorkerCommand) => (c.type === 'account.password.info' ? { info } : null)
    expect(await json(await send(ta.app, `/api/accounts/${a.id}/cloud-password/info`, { cookie }))).toEqual(info)
    expect(ta.commands.sent).toEqual([{ type: 'account.password.info', accountId: a.id }])

    ta.commands.respond = () => ({ error: 'not_running' })
    const offline = await send(ta.app, `/api/accounts/${a.id}/cloud-password/info`, { cookie })
    expect(offline.status).toBe(409)
    expect(await json(offline)).toMatchObject({ error: 'not_running', message: 'Аккаунт сейчас не подключён к Telegram' })
  })

  it('shows the stored password on request and writes that into the audit log', async () => {
    const a = await insertAccount({ cloudPasswordEnc: ta.deps.cipher.encrypt('kn0wn-pass') })
    const res = await send(ta.app, `/api/accounts/${a.id}/cloud-password`, { cookie })
    expect(await json(res)).toEqual({ password: 'kn0wn-pass' })
    expect(await lastAudit('account.cloud_password.read')).toMatchObject({ targetId: a.id, result: 'ok' })
    expect(JSON.stringify(await ta.t.db.select().from(auditLog))).not.toContain('kn0wn-pass')

    const b = await insertAccount()
    const unknown = await send(ta.app, `/api/accounts/${b.id}/cloud-password`, { cookie })
    expect(unknown.status).toBe(404)
    expect(await json(unknown)).toMatchObject({ error: 'password_unknown' })
  })

  it('sends passwords and codes to the worker only encrypted, and never into the audit log', async () => {
    const a = await insertAccount()
    ta.commands.respond = (c: WorkerCommand) => (c.type === 'account.password.set' ? { emailCodeNeeded: { pattern: 'm***@example.com', length: 6 } } : { ok: true })
    const set = await send(ta.app, `/api/accounts/${a.id}/cloud-password`, {
      cookie,
      method: 'PUT',
      body: { currentPassword: 'old-s3cret', newPassword: 'new-s3cret', hint: 'кот', email: 'me@example.com' },
    })
    expect(await json(set)).toEqual({ emailCodeNeeded: { pattern: 'm***@example.com', length: 6 } })
    expect((await send(ta.app, `/api/accounts/${a.id}/cloud-password/verify`, { cookie, body: { password: 'cur-s3cret' } })).status).toBe(204)
    expect((await send(ta.app, `/api/accounts/${a.id}/cloud-password/email`, { cookie, body: { action: 'confirm', code: '424 242' } })).status).toBe(204)
    expect((await send(ta.app, `/api/accounts/${a.id}/cloud-password/email`, { cookie, body: { action: 'cancel' } })).status).toBe(204)

    const [setCmd, verifyCmd, confirmCmd, cancelCmd] = ta.commands.sent as Extract<WorkerCommand, { accountId: string }>[]
    expect(setCmd).toMatchObject({ type: 'account.password.set', accountId: a.id, hint: 'кот', email: 'me@example.com' })
    const decrypt = (v: unknown) => ta.deps.cipher.decrypt(String(v))
    if (setCmd?.type !== 'account.password.set' || verifyCmd?.type !== 'account.password.verify' || confirmCmd?.type !== 'account.password.email') throw new Error('unexpected commands')
    expect([decrypt(setCmd.currentPasswordEnc), decrypt(setCmd.newPasswordEnc), decrypt(verifyCmd.passwordEnc), decrypt(confirmCmd.codeEnc)]).toEqual([
      'old-s3cret',
      'new-s3cret',
      'cur-s3cret',
      '424242',
    ])
    expect(cancelCmd).toEqual({ type: 'account.password.email', accountId: a.id, action: 'cancel', codeEnc: null })
    for (const secret of ['old-s3cret', 'new-s3cret', 'cur-s3cret', '424242']) {
      expect(JSON.stringify(ta.commands.sent)).not.toContain(secret)
      expect(JSON.stringify(await ta.t.db.select().from(auditLog))).not.toContain(secret)
    }
    expect(await lastAudit('account.cloud_password.set')).toMatchObject({ targetId: a.id, payload: null })
  })

  it('turns what the worker refused into words', async () => {
    const a = await insertAccount()
    const put = (respond: unknown) => {
      ta.commands.respond = () => respond
      return send(ta.app, `/api/accounts/${a.id}/cloud-password`, { cookie, method: 'PUT', body: { newPassword: 'n' } })
    }
    const cases: [unknown, number, string, string][] = [
      [{ error: 'wrong_password' }, 422, 'wrong_password', 'Неверный текущий пароль'],
      [{ error: 'stale_password' }, 409, 'stale_password', 'Сохранённый пароль не подошёл — его сменили вне панели. Укажите текущий'],
      [{ error: 'password_unknown' }, 409, 'password_unknown', 'Панель не знает текущий пароль — введите его'],
      [{ error: 'too_fresh', retryAfterSec: 80_000 }, 409, 'too_fresh', 'Telegram пока не даёт менять пароль с этой сессии — подождите 23 ч'],
      [{ error: 'email_invalid' }, 422, 'email_invalid', 'Неверная почта'],
      [{ error: 'other', message: '400 PASSWORD_HINT_INVALID' }, 503, 'telegram_error', 'Telegram отказал: 400 PASSWORD_HINT_INVALID'],
    ]
    for (const [respond, status, error, message] of cases) {
      const res = await put(respond)
      expect([res.status, await json(res)]).toEqual([status, expect.objectContaining({ error, message })])
    }
    ta.commands.respond = () => ({ error: 'code_invalid' })
    const code = await send(ta.app, `/api/accounts/${a.id}/cloud-password/email`, { cookie, body: { action: 'confirm', code: '1' } })
    expect(code.status).toBe(400)
    const wrong = await send(ta.app, `/api/accounts/${a.id}/cloud-password/email`, { cookie, body: { action: 'confirm', code: '123456' } })
    expect([wrong.status, await json(wrong)]).toEqual([422, expect.objectContaining({ error: 'code_invalid', message: 'Неверный код' })])
  })

  it('404 for an unknown account', async () => {
    const res = await send(ta.app, '/api/accounts/00000000-0000-4000-8000-000000000999/cloud-password/info', { cookie })
    expect(res.status).toBe(404)
  })
})
```

- [ ] **Шаг 2: Убедиться, что тест падает**

```bash
fnm exec --using=26 npx vitest run --project api apps/api/test/cloud-password.test.ts
# FAIL: 4 из 5 — маршрутов нет (тест про 404 для неизвестного аккаунта проходит и до реализации, он защитный)
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
+import { cloudPasswordRoutes } from './routes/cloud-password.ts'
 import { phoneLoginRoutes } from './routes/phone-login.ts'
 import { qrRoutes } from './routes/qr.ts'
 import { settingsRoutes } from './routes/settings.ts'
@@ -73,6 +74,7 @@ export function createApp(deps: AppDeps): Hono<AppEnv> {
   api.route('/', accountRoutes)
   api.route('/', qrRoutes)
   api.route('/', phoneLoginRoutes)
+  api.route('/', cloudPasswordRoutes)
   api.route('/', codeRoutes)
   api.route('/', auditRoutes)
   api.route('/', eventRoutes)
```

`apps/api/src/routes/cloud-password.ts` — новый файл

```ts
import { zValidator } from '@hono/zod-validator'
import { accounts, eq } from '@workspace/db'
import { cloudPasswordEmailInput, setCloudPasswordInput, verifyCloudPasswordInput } from '@workspace/shared/accounts'
import type {
  CloudPasswordEmailResult,
  CloudPasswordError,
  CloudPasswordInfoResult,
  CloudPasswordSetResult,
  CloudPasswordVerifyResult,
} from '@workspace/shared/commands'
import { Hono } from 'hono'
import { z } from 'zod'
import type { AppEnv } from '../deps.ts'
import { DomainError } from '../lib/errors.ts'
import { audited } from '../middleware/audit.ts'
import { getAccount } from '../services/accounts.ts'
import { validationHook } from './validation.ts'

const idParam = z.object({ id: z.uuid() })

/** What the worker refused, for the admin. */
function refusal(result: CloudPasswordError): DomainError {
  switch (result.error) {
    case 'not_running':
      return new DomainError(409, 'not_running', 'Аккаунт сейчас не подключён к Telegram')
    case 'wrong_password':
      return new DomainError(422, 'wrong_password', 'Неверный текущий пароль')
    case 'stale_password':
      return new DomainError(409, 'stale_password', 'Сохранённый пароль не подошёл — его сменили вне панели. Укажите текущий')
    case 'password_unknown':
      return new DomainError(409, 'password_unknown', 'Панель не знает текущий пароль — введите его')
    case 'too_fresh':
      return new DomainError(409, 'too_fresh', `Telegram пока не даёт менять пароль с этой сессии — подождите ${Math.max(1, Math.ceil(result.retryAfterSec / 3600))} ч`)
    case 'email_invalid':
      return new DomainError(422, 'email_invalid', 'Неверная почта')
    case 'code_invalid':
      return new DomainError(422, 'code_invalid', 'Неверный код')
    case 'code_expired':
      return new DomainError(409, 'code_expired', 'Код истёк — отправьте снова')
    case 'other':
      return new DomainError(503, 'telegram_error', `Telegram отказал: ${result.message}`)
  }
}
const failed = (result: object): result is CloudPasswordError => 'error' in result

/**
 * The cloud (2FA) password of an account. Passwords and codes go to the worker encrypted and never into the audit
 * log; showing the stored password is an audited read.
 */
export const cloudPasswordRoutes = new Hono<AppEnv>()
  .get('/accounts/:id/cloud-password/info', zValidator('param', idParam, validationHook), async (c) => {
    const { db, commands } = c.get('deps')
    const { id } = c.req.valid('param')
    await getAccount(db, id)
    const result = await commands.call<CloudPasswordInfoResult>({ type: 'account.password.info', accountId: id })
    if (failed(result)) throw refusal(result)
    return c.json(result.info)
  })
  .get('/accounts/:id/cloud-password', audited('account.cloud_password.read', { target: ['account', 'id'] }), zValidator('param', idParam, validationHook), async (c) => {
    const { db, cipher } = c.get('deps')
    const { id } = c.req.valid('param')
    await getAccount(db, id)
    const [row] = await db.select({ enc: accounts.cloudPasswordEnc }).from(accounts).where(eq(accounts.id, id))
    if (!row?.enc) throw new DomainError(404, 'password_unknown', 'Панель не знает облачный пароль этого аккаунта')
    return c.json({ password: cipher.decrypt(row.enc) })
  })
  .post('/accounts/:id/cloud-password/verify', audited('account.cloud_password.verify', { payload: null, target: ['account', 'id'] }), zValidator('param', idParam, validationHook), zValidator('json', verifyCloudPasswordInput, validationHook), async (c) => {
    const { db, cipher, commands } = c.get('deps')
    const { id } = c.req.valid('param')
    await getAccount(db, id)
    const result = await commands.call<CloudPasswordVerifyResult>({ type: 'account.password.verify', accountId: id, passwordEnc: cipher.encrypt(c.req.valid('json').password) })
    if (failed(result)) throw refusal(result)
    return c.body(null, 204)
  })
  .put('/accounts/:id/cloud-password', audited('account.cloud_password.set', { payload: null, target: ['account', 'id'] }), zValidator('param', idParam, validationHook), zValidator('json', setCloudPasswordInput, validationHook), async (c) => {
    const { db, cipher, commands } = c.get('deps')
    const { id } = c.req.valid('param')
    await getAccount(db, id)
    const input = c.req.valid('json')
    const result = await commands.call<CloudPasswordSetResult>({
      type: 'account.password.set',
      accountId: id,
      currentPasswordEnc: input.currentPassword ? cipher.encrypt(input.currentPassword) : null,
      newPasswordEnc: cipher.encrypt(input.newPassword),
      hint: input.hint || null,
      email: input.email ?? null,
    })
    if (failed(result)) throw refusal(result)
    return c.json(result)
  })
  .post('/accounts/:id/cloud-password/email', audited('account.cloud_password.email', { payload: null, target: ['account', 'id'] }), zValidator('param', idParam, validationHook), zValidator('json', cloudPasswordEmailInput, validationHook), async (c) => {
    const { db, cipher, commands } = c.get('deps')
    const { id } = c.req.valid('param')
    await getAccount(db, id)
    const input = c.req.valid('json')
    const result = await commands.call<CloudPasswordEmailResult>({
      type: 'account.password.email',
      accountId: id,
      action: input.action,
      codeEnc: input.action === 'confirm' ? cipher.encrypt(input.code) : null,
    })
    if (failed(result)) throw refusal(result)
    return c.body(null, 204)
  })
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
feat(api): cloud password — state, audited reveal of the stored password, verify, set/change with a recovery email and its code; secrets encrypted to the worker, kept out of the audit log
MSG
```

---

### Task 7: Web: вкладка «По номеру»

Шаги:
1. **Подключение и номер.** «Напрямую» — только явным выбором.
2. **Код.** Куда ушёл код (в приложение Telegram, по SMS, звонком, на почту), длина кода. «Отправить ещё раз» доступна после отсчёта и подписана следующим способом. «Неверный код» и «Код истёк» — под полем.
3. **Облачный пароль.** Подсказка, «неверный пароль» держится до следующей попытки.
4. **Готово** — открывается карточка нового аккаунта.

Как и в QR, вкладка держит событие, пришедшее раньше ответа `POST /phone-login`, и отменяет вход при закрытии. Источник «по номеру» подписан в списке и в карточке.

Отсчёт обновляется по интервалу, пока срок не прошёл. Первая версия с «застывшим» `now` держала кнопку выключенной, и тест это поймал.

**Files:**
- Modify: `apps/web/src/components/accounts/add-account-dialog.tsx`
- Test: `apps/web/src/components/accounts/phone-login-tab.test.tsx`
- Create: `apps/web/src/components/accounts/phone-login-tab.tsx`
- Modify: `apps/web/src/routes/_authed/accounts/$id.tsx`
- Modify: `apps/web/src/routes/_authed/accounts/index.tsx`

**Interfaces:**
- Consumes: `/api/phone-login*` (задача 4), событие `phone.update` (задача 1), `RouteSelect`, `useAppEvent`, `PasswordInput` (план 2).
- Produces:
  - `apps/web/src/components/accounts/phone-login-tab.tsx`: `PhoneLoginTab({ onDone }: { onDone: () => void })`

- [ ] **Шаг 1: Написать падающий тест**

`apps/web/src/components/accounts/phone-login-tab.test.tsx` — новый файл

```tsx
import { act, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { AppEvent } from '@workspace/shared/events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { emitAppEvent } from '@/lib/app-events'
import { proxyFixture } from '@/test/fixtures'
import { json, renderWithClient } from '@/test/render'
import { PhoneLoginTab } from './phone-login-tab'

const navigate = vi.fn()
vi.mock('@tanstack/react-router', async (importOriginal) => ({ ...(await importOriginal<object>()), useNavigate: () => navigate }))

const LOGIN_ID = '00000000-0000-4000-8000-0000000000e1'
const phone = (patch: Omit<Extract<AppEvent, { type: 'phone.update' }>, 'type' | 'loginId'>, loginId = LOGIN_ID) =>
  act(() => emitAppEvent({ type: 'phone.update', loginId, ...patch }))
const codeSent = { state: 'code_sent' as const, deliveryType: 'app', codeLength: 5, nextType: 'sms', retryAfterSec: 60 }

let fetchMock: ReturnType<typeof vi.fn>
beforeEach(() => {
  navigate.mockReset()
  fetchMock = vi.fn(async (url: string) => {
    if (url === '/api/proxies') return json({ items: [proxyFixture()] })
    if (url === '/api/phone-login') return json({ loginId: LOGIN_ID }, 201)
    return new Response(null, { status: 202 })
  })
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => vi.unstubAllGlobals())

const bodyOf = (path: string) => {
  const calls = fetchMock.mock.calls.filter(([url]) => url === path) as [string, RequestInit][]
  return calls.map(([, init]) => (init.body ? JSON.parse(String(init.body)) : null))
}

async function startLogin(user: ReturnType<typeof userEvent.setup>) {
  await waitFor(() => expect(screen.getByLabelText('Подключение')).toHaveTextContent('194.53.188.10:50101'))
  await user.type(screen.getByLabelText('Номер телефона'), '+7 700 123 45 67')
  await user.click(screen.getByRole('button', { name: 'Получить код' }))
  await waitFor(() => expect(bodyOf('/api/phone-login')).toEqual([{ phone: '+7 700 123 45 67', proxyId: proxyFixture().id }]))
}

describe('PhoneLoginTab', () => {
  it('goes through the code (wrong first), the cloud password (wrong first) and opens the new account', async () => {
    const onDone = vi.fn()
    const user = userEvent.setup()
    renderWithClient(<PhoneLoginTab onDone={onDone} />)
    await startLogin(user)

    await phone(codeSent)
    expect(await screen.findByText('Код отправлен в приложение Telegram — сообщением от «Telegram»')).toBeInTheDocument()
    expect(screen.getByText('Код из 5 цифр')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Отправить по SMS/ })).toBeDisabled()

    await user.type(screen.getByLabelText('Код'), '11111')
    await user.click(screen.getByRole('button', { name: 'Войти' }))
    await waitFor(() => expect(bodyOf(`/api/phone-login/${LOGIN_ID}/code`)).toEqual([{ code: '11111' }]))
    await phone({ ...codeSent, state: 'code_invalid' })
    expect(screen.getByText('Неверный код')).toBeInTheDocument()
    expect((screen.getByLabelText('Код') as HTMLInputElement).value).toBe('')

    await phone({ state: 'password_needed', hint: 'кот' })
    expect(screen.getByText('Подсказка: кот')).toBeInTheDocument()
    await user.type(screen.getByLabelText('Облачный пароль'), 'wrong')
    await user.click(screen.getByRole('button', { name: 'Войти' }))
    await waitFor(() => expect(bodyOf(`/api/phone-login/${LOGIN_ID}/password`)).toEqual([{ password: 'wrong' }]))
    await phone({ state: 'password_invalid', hint: 'кот' })
    expect(screen.getByText('Неверный пароль — попробуйте ещё раз')).toBeInTheDocument()

    await phone({ state: 'done', accountId: '00000000-0000-4000-8000-0000000000a1' })
    expect(onDone).toHaveBeenCalled()
    expect(navigate).toHaveBeenCalledWith({ to: '/accounts/$id', params: { id: '00000000-0000-4000-8000-0000000000a1' } })
  })

  it('lets the code be sent again once Telegram allows it, by the next method', async () => {
    const user = userEvent.setup()
    renderWithClient(<PhoneLoginTab onDone={vi.fn()} />)
    await startLogin(user)
    await phone({ ...codeSent, retryAfterSec: 0 })
    await user.click(await screen.findByRole('button', { name: 'Отправить по SMS' }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(`/api/phone-login/${LOGIN_ID}/resend`, expect.objectContaining({ method: 'POST' })))
    await phone({ ...codeSent, deliveryType: 'sms', nextType: 'none', state: 'code_expired' })
    expect(screen.getByText('Код истёк — запросите новый')).toBeInTheDocument()
    expect(screen.getByText('Код отправлен по SMS')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Отправить/ })).not.toBeInTheDocument()
  })

  it('keeps an event that arrives before POST /phone-login answers', async () => {
    let answer!: () => void
    fetchMock.mockImplementation(async (url: string) => {
      if (url === '/api/proxies') return json({ items: [proxyFixture()] })
      if (url === '/api/phone-login') {
        await new Promise<void>((resolve) => (answer = resolve))
        return json({ loginId: LOGIN_ID }, 201)
      }
      return new Response(null, { status: 202 })
    })
    const user = userEvent.setup()
    renderWithClient(<PhoneLoginTab onDone={vi.fn()} />)
    await waitFor(() => expect(screen.getByLabelText('Подключение')).toHaveTextContent('194.53.188.10'))
    await user.type(screen.getByLabelText('Номер телефона'), '77001234567')
    await user.click(screen.getByRole('button', { name: 'Получить код' }))
    await waitFor(() => expect(answer).toBeTypeOf('function'))
    await phone(codeSent)
    await act(async () => answer())
    expect(await screen.findByLabelText('Код')).toBeInTheDocument()
  })

  it('shows why the login failed and starts over', async () => {
    const user = userEvent.setup()
    renderWithClient(<PhoneLoginTab onDone={vi.fn()} />)
    await startLogin(user)
    await phone({ state: 'failed', message: 'Номер заблокирован Telegram' })
    expect(await screen.findByText('Не удалось войти')).toBeInTheDocument()
    expect(screen.getByText('Номер заблокирован Telegram')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Начать заново' }))
    expect(screen.getByRole('button', { name: 'Получить код' })).toBeInTheDocument()
  })

  it('cancels a running login on the worker when closed', async () => {
    const user = userEvent.setup()
    const { unmount } = renderWithClient(<PhoneLoginTab onDone={vi.fn()} />)
    await startLogin(user)
    await phone(codeSent)
    await screen.findByLabelText('Код')
    unmount()
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(`/api/phone-login/${LOGIN_ID}`, expect.objectContaining({ method: 'DELETE' })))
  })
})
```

- [ ] **Шаг 2: Убедиться, что тест падает**

```bash
fnm exec --using=26 npx vitest run --project web apps/web/src/components/accounts/phone-login-tab.test.tsx
# FAIL: Failed to resolve import "./phone-login-tab"
```

- [ ] **Шаг 3: Реализация**

`apps/web/src/components/accounts/add-account-dialog.tsx` — изменения

```diff
--- a/apps/web/src/components/accounts/add-account-dialog.tsx
+++ b/apps/web/src/components/accounts/add-account-dialog.tsx
@@ -4,6 +4,7 @@ import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, Di
 import { Tabs, TabsContent, TabsList, TabsTrigger } from '@workspace/ui/components/tabs'
 import { PlusIcon } from 'lucide-react'
 import { ImportTdataTab } from './import-tdata-tab'
+import { PhoneLoginTab } from './phone-login-tab'
 import { QrLoginTab } from './qr-login-tab'
 
 export function AddAccountDialog() {
@@ -26,12 +27,13 @@ export function AddAccountDialog() {
       <DialogContent className="sm:max-w-3xl">
         <DialogHeader>
           <DialogTitle>Новый аккаунт</DialogTitle>
-          <DialogDescription>Перенос сессии из Telegram Desktop или вход новой сессией по QR-коду.</DialogDescription>
+          <DialogDescription>Перенос сессии из Telegram Desktop или вход новой сессией — по QR-коду или по номеру телефона.</DialogDescription>
         </DialogHeader>
         <Tabs defaultValue="tdata" key={session}>
           <TabsList>
             <TabsTrigger value="tdata">Из tdata</TabsTrigger>
             <TabsTrigger value="qr">По QR-коду</TabsTrigger>
+            <TabsTrigger value="phone">По номеру</TabsTrigger>
           </TabsList>
           <TabsContent value="tdata" className="pt-4">
             <ImportTdataTab onDone={close} />
@@ -39,6 +41,9 @@ export function AddAccountDialog() {
           <TabsContent value="qr" className="pt-4">
             <QrLoginTab onDone={close} />
           </TabsContent>
+          <TabsContent value="phone" className="pt-4">
+            <PhoneLoginTab onDone={close} />
+          </TabsContent>
         </Tabs>
       </DialogContent>
     </Dialog>
```

`apps/web/src/components/accounts/phone-login-tab.tsx` — новый файл

```tsx
import * as React from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import type { PhoneLoginState } from '@workspace/shared/accounts'
import { Alert, AlertDescription, AlertTitle } from '@workspace/ui/components/alert'
import { Button } from '@workspace/ui/components/button'
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from '@workspace/ui/components/field'
import { Input } from '@workspace/ui/components/input'
import { Spinner } from '@workspace/ui/components/spinner'
import { toast } from '@workspace/ui/components/toast'
import { PasswordInput } from '@/components/password-input'
import { accountsQueryOptions, freeProxies } from '@/lib/accounts'
import { api } from '@/lib/api'
import { useAppEvent } from '@/lib/app-events'
import { proxiesQueryOptions } from '@/lib/proxies'
import { RouteSelect } from './route-select'

interface PhoneProgress {
  state: PhoneLoginState
  deliveryType?: string
  codeLength?: number
  nextType?: string
  retryAfterSec?: number
  hint?: string
  message?: string
  accountId?: string
}

const FINISHED: PhoneLoginState[] = ['done', 'failed', 'expired', 'cancelled']

/** Where Telegram sent the code, as the admin reads it. */
const DELIVERY: Record<string, string> = {
  app: 'в приложение Telegram — сообщением от «Telegram»',
  sms: 'по SMS',
  sms_word: 'по SMS',
  sms_phrase: 'по SMS',
  firebase: 'по SMS',
  call: 'звонком — код продиктуют',
  flash_call: 'звонком — код в последних цифрах номера',
  missed_call: 'пропущенным звонком — код в последних цифрах номера',
  email: 'на почту',
  fragment: 'в Fragment',
}
const RESEND: Record<string, string> = {
  sms: 'Отправить по SMS',
  call: 'Позвонить',
  flash_call: 'Позвонить',
  missed_call: 'Позвонить',
  email: 'Отправить на почту',
  fragment: 'Отправить в Fragment',
}

/** Seconds left until `until`, ticking until it passes. */
function useSecondsLeft(until: number | null): number {
  const [now, setNow] = React.useState(() => Date.now())
  React.useEffect(() => {
    if (until === null) return
    const timer = setInterval(() => {
      const current = Date.now()
      setNow(current)
      if (current >= until) clearInterval(timer)
    }, 250)
    return () => clearInterval(timer)
  }, [until])
  return until === null ? 0 : Math.max(0, Math.ceil((until - now) / 1000))
}

/** Login by phone number: the code arrives in the account's open apps (Telegram Desktop works), then 2FA. */
export function PhoneLoginTab({ onDone }: { onDone: () => void }) {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const proxies = useQuery(proxiesQueryOptions)
  const free = freeProxies(proxies.data?.items ?? [])
  const [route, setRoute] = React.useState<string | null>(null)
  const [phone, setPhone] = React.useState('')
  const [loginId, setLoginId] = React.useState<string | null>(null)
  const [progress, setProgress] = React.useState<PhoneProgress | null>(null)
  const [delivery, setDelivery] = React.useState<PhoneProgress | null>(null)
  const [resendAt, setResendAt] = React.useState<number | null>(null)
  const [code, setCode] = React.useState('')
  const [password, setPassword] = React.useState('')
  // «напрямую» only by an explicit choice: with no free proxy the admin has to pick it
  const effectiveRoute = route ?? free[0]?.id ?? null
  // the worker may answer before POST /phone-login does: keep such events until the id is known
  const early = React.useRef(new Map<string, PhoneProgress>())
  const secondsLeft = useSecondsLeft(resendAt)

  const apply = (event: PhoneProgress) => {
    setProgress(event)
    if (event.deliveryType) {
      setDelivery(event)
      if (event.state === 'code_sent') setResendAt(Date.now() + (event.retryAfterSec ?? 0) * 1000)
    }
  }

  const start = useMutation({
    mutationFn: () => api<{ loginId: string }>('/phone-login', { method: 'POST', json: { phone, proxyId: effectiveRoute === 'direct' ? null : effectiveRoute } }),
    onSuccess: ({ loginId }) => {
      setLoginId(loginId)
      const first = early.current.get(loginId)
      if (first) apply(first)
      early.current.clear()
    },
  })
  const sendCode = useMutation({
    mutationFn: () => api(`/phone-login/${loginId}/code`, { method: 'POST', json: { code } }),
    onSuccess: () => setCode(''),
  })
  const sendPassword = useMutation({
    mutationFn: () => api(`/phone-login/${loginId}/password`, { method: 'POST', json: { password } }),
    onSuccess: () => setPassword(''),
  })
  const resend = useMutation({ mutationFn: () => api(`/phone-login/${loginId}/resend`, { method: 'POST' }) })

  useAppEvent((event) => {
    if (event.type !== 'phone.update') return
    if (event.loginId !== loginId) {
      if (start.isPending) early.current.set(event.loginId, event)
      return
    }
    apply(event)
    if (event.state === 'done') {
      void queryClient.invalidateQueries({ queryKey: accountsQueryOptions.queryKey })
      toast.add({ title: 'Аккаунт добавлен по номеру' })
      onDone()
      if (event.accountId) void navigate({ to: '/accounts/$id', params: { id: event.accountId } })
    }
  })

  // closing the dialog mid-login cancels it on the worker
  const live = loginId !== null && (progress === null || !FINISHED.includes(progress.state))
  const liveRef = React.useRef({ live, loginId })
  React.useEffect(() => {
    liveRef.current = { live, loginId }
  })
  React.useEffect(
    () => () => {
      if (liveRef.current.live) void api(`/phone-login/${liveRef.current.loginId}`, { method: 'DELETE' }).catch(() => {})
    },
    [],
  )

  const reset = () => {
    setLoginId(null)
    setProgress(null)
    setDelivery(null)
    setResendAt(null)
    setCode('')
    setPassword('')
    start.reset()
  }

  if (!loginId || !progress) {
    return (
      <form
        className="flex flex-col gap-6"
        onSubmit={(e) => {
          e.preventDefault()
          start.mutate()
        }}
      >
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="phone-route">Подключение</FieldLabel>
            <RouteSelect
              id="phone-route"
              value={effectiveRoute}
              onChange={setRoute}
              proxies={free}
              special={[{ value: 'direct', label: 'Напрямую, без прокси' }]}
              placeholder="Свободных прокси нет — выберите вариант"
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="phone-number">Номер телефона</FieldLabel>
            <Input id="phone-number" type="tel" inputMode="tel" autoComplete="off" placeholder="+7 700 123 45 67" value={phone} onChange={(e) => setPhone(e.target.value)} />
            <FieldDescription>
              Код придёт в открытые приложения Telegram этого аккаунта — подойдёт и Telegram Desktop. Нужен свой api_id (Настройки → Telegram).
            </FieldDescription>
          </Field>
        </FieldGroup>
        {start.error && (
          <Alert variant="destructive">
            <AlertDescription>{start.error.message}</AlertDescription>
          </Alert>
        )}
        <div className="flex justify-end">
          <Button type="submit" disabled={!phone.trim() || effectiveRoute === null || start.isPending || (start.isSuccess && !progress)}>
            {(start.isPending || (start.isSuccess && !progress)) && <Spinner data-icon="inline-start" />}
            Получить код
          </Button>
        </div>
      </form>
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
          <FieldLabel htmlFor="phone-password">Облачный пароль</FieldLabel>
          <PasswordInput id="phone-password" autoFocus autoComplete="off" required value={password} onChange={(e) => setPassword(e.target.value)} aria-invalid={invalid ? true : undefined} />
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

  if (progress.state === 'done') {
    return (
      <div className="flex h-40 items-center justify-center">
        <Spinner />
      </div>
    )
  }

  // the code: code_sent, code_invalid, code_expired
  const where = delivery?.deliveryType ? (DELIVERY[delivery.deliveryType] ?? delivery.deliveryType) : null
  const nextType = delivery?.nextType ?? 'none'
  const error = progress.state === 'code_invalid' ? 'Неверный код' : progress.state === 'code_expired' ? 'Код истёк — запросите новый' : null
  return (
    <form
      className="flex flex-col gap-6"
      onSubmit={(e) => {
        e.preventDefault()
        sendCode.mutate()
      }}
    >
      {where && <p className="text-sm">Код отправлен {where}</p>}
      <Field data-invalid={error ? true : undefined}>
        <FieldLabel htmlFor="phone-code">Код</FieldLabel>
        <Input
          id="phone-code"
          autoFocus
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={delivery?.codeLength ? delivery.codeLength + 4 : undefined}
          value={code}
          onChange={(e) => setCode(e.target.value)}
          aria-invalid={error ? true : undefined}
        />
        {delivery?.codeLength ? <FieldDescription>Код из {delivery.codeLength} цифр</FieldDescription> : null}
        {error && <FieldError>{error}</FieldError>}
      </Field>
      <div className="flex flex-wrap justify-end gap-2">
        {nextType !== 'none' && (
          <Button type="button" variant="ghost" disabled={secondsLeft > 0 || resend.isPending} onClick={() => resend.mutate()}>
            {RESEND[nextType] ?? 'Отправить ещё раз'}
            {secondsLeft > 0 ? ` через ${secondsLeft} с` : ''}
          </Button>
        )}
        <Button type="submit" disabled={!code.trim() || sendCode.isPending}>
          {sendCode.isPending && <Spinner data-icon="inline-start" />}
          Войти
        </Button>
      </div>
    </form>
  )
}
```

`apps/web/src/routes/_authed/accounts/$id.tsx` — изменения

```diff
--- a/apps/web/src/routes/_authed/accounts/$id.tsx
+++ b/apps/web/src/routes/_authed/accounts/$id.tsx
@@ -71,7 +71,7 @@ function ProfileCard({ a }: { a: AccountDto }) {
             <span title={formatDateTime(a.lastOkAt)}>{formatRelative(a.lastOkAt)}</span>
           </Row>
           <Row label="Добавлен">
-            {formatDate(a.createdAt)} · {a.source === 'tdata' ? 'из tdata' : 'вход по QR'}
+            {formatDate(a.createdAt)} · {{ tdata: 'из tdata', qr: 'вход по QR', phone: 'вход по номеру' }[a.source]}
           </Row>
           <Row label="Устройство">
             {a.device.deviceModel}, {a.device.systemVersion}, {a.clientProfile === 'desktop' ? 'Telegram Desktop' : 'своё приложение'} {a.device.appVersion}
```

`apps/web/src/routes/_authed/accounts/index.tsx` — изменения

```diff
--- a/apps/web/src/routes/_authed/accounts/index.tsx
+++ b/apps/web/src/routes/_authed/accounts/index.tsx
@@ -2,7 +2,7 @@ import * as React from 'react'
 import { useMutation, useQueryClient, useSuspenseQuery } from '@tanstack/react-query'
 import { createFileRoute, Link } from '@tanstack/react-router'
 import { createColumnHelper } from '@tanstack/react-table'
-import { accountTitle, type AccountDto } from '@workspace/shared/accounts'
+import { accountSourceLabels, accountTitle, type AccountDto } from '@workspace/shared/accounts'
 import { Badge } from '@workspace/ui/components/badge'
 import { Button } from '@workspace/ui/components/button'
 import {
@@ -92,7 +92,7 @@ function AccountsPage() {
         }),
         col.accessor('lastCodeAt', { header: 'Последний код', cell: (info) => <span title={formatDateTime(info.getValue())}>{formatRelative(info.getValue())}</span> }),
         col.accessor('lastOkAt', { header: 'На связи', cell: (info) => <span title={formatDateTime(info.getValue())} className="text-muted-foreground text-sm">{formatRelative(info.getValue())}</span> }),
-        col.accessor('source', { header: 'Источник', cell: (info) => (info.getValue() === 'tdata' ? 'tdata' : 'QR') }),
+        col.accessor('source', { header: 'Источник', cell: (info) => accountSourceLabels[info.getValue()] }),
         col.display({
           id: 'actions',
           header: () => <span className="sr-only">Действия</span>,
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
feat(web): «По номеру» tab — phone, where the code went, resend by the next method after Telegram's timeout, cloud password, cancel on close; «по номеру» source label
MSG
```

---

### Task 8: Web: облачный пароль в карточке аккаунта

Блок в карточке показывает:
- установлен ли пароль, подсказку;
- пароль точками и «Показать» / «Скрыть», если панель его знает, иначе «неизвестен панели» и «Указать текущий»;
- почту восстановления: адрес, или «привязана» / «не привязана», или «ожидает подтверждения» с кнопкой «Ввести код из письма»;
- красное предупреждение об отложенном сбросе.

Диалоги:
- **«Текущий облачный пароль»** — проверка у Telegram.
- **«Новый облачный пароль»** — текущий спрашивается, только если неизвестен; повтор пароля, подсказка, почта. Ошибки показываются у своего поля.
- **«Код из письма»** — подтвердить, отправить ещё раз, пропустить.

Состояние запрашивается, только когда аккаунт подключён. Оно не перезапрашивается на каждое событие аккаунта (`ON_DEMAND_ACCOUNT_QUERIES` в `routes/_authed.tsx`), иначе каждый новый код дёргал бы Telegram.

**Files:**
- Test: `apps/web/src/components/accounts/cloud-password-card.test.tsx`
- Create: `apps/web/src/components/accounts/cloud-password-card.tsx`
- Create: `apps/web/src/components/accounts/cloud-password-dialogs.tsx`
- Modify: `apps/web/src/lib/accounts.ts`
- Modify: `apps/web/src/routes/_authed.tsx`
- Modify: `apps/web/src/routes/_authed/accounts/$id.tsx`

**Interfaces:**
- Consumes: `/api/accounts/:id/cloud-password*` (задача 6), `CloudPasswordInfoDto`, `EmailCodeNeeded` (задача 1).
- Produces:
  - `apps/web/src/components/accounts/cloud-password-card.tsx`: `CloudPasswordCard({ account }: { account: AccountDto })`
  - `apps/web/src/components/accounts/cloud-password-dialogs.tsx`: `VerifyPasswordDialog({ accountId, open, onOpenChange, onChanged }: DialogProps)`; `SetPasswordDialog({ accountId, info, open, onOpenChange, onChanged, onEmailCode }: DialogProps & { info: CloudPasswordInfoDto; onEmailCode: (step: EmailCodeNeeded) => void })`; `EmailCodeDialog({ accountId, step, open, onOpenChange, onChanged }: DialogProps & { step: EmailCodeNeeded | null })`
  - `apps/web/src/lib/accounts.ts`: `cloudPasswordInfoQueryOptions`; `ON_DEMAND_ACCOUNT_QUERIES`

- [ ] **Шаг 1: Написать падающий тест**

`apps/web/src/components/accounts/cloud-password-card.test.tsx` — новый файл

```tsx
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { CloudPasswordInfoDto } from '@workspace/shared/accounts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { accountFixture } from '@/test/fixtures'
import { json, renderWithClient } from '@/test/render'
import { CloudPasswordCard } from './cloud-password-card'

const account = accountFixture({ status: 'active' })
const base = `/api/accounts/${account.id}/cloud-password`
const info = (over: Partial<CloudPasswordInfoDto> = {}): CloudPasswordInfoDto => ({
  hasPassword: false,
  hint: null,
  known: false,
  hasRecovery: false,
  recoveryEmail: null,
  unconfirmedEmailPattern: null,
  pendingResetAt: null,
  ...over,
})

afterEach(() => vi.unstubAllGlobals())

/** The api as the test scripts it; `state` is what /info returns now. */
function api(state: { info: CloudPasswordInfoDto }, handlers: Record<string, (body: unknown) => Response> = {}) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${url}`
    const body = init?.body ? JSON.parse(String(init.body)) : null
    if (handlers[key]) return handlers[key](body)
    if (key === `GET ${base}/info`) return json(state.info)
    return new Response(null, { status: 204 })
  })
  vi.stubGlobal('fetch', fetchMock)
  const calls = (key: string) =>
    fetchMock.mock.calls.filter(([url, init]) => `${(init as RequestInit | undefined)?.method ?? 'GET'} ${url}` === key).map(([, init]) => JSON.parse(String((init as RequestInit).body ?? 'null')))
  return { fetchMock, calls }
}

describe('CloudPasswordCard', () => {
  it('shows what Telegram says: a password the panel does not know, the recovery email and a pending reset', async () => {
    api({ info: info({ hasPassword: true, hint: 'кот', hasRecovery: true, pendingResetAt: '2026-10-10T09:00:00.000Z' }) })
    renderWithClient(<CloudPasswordCard account={account} />)
    expect(await screen.findByText('установлен')).toBeInTheDocument()
    expect(screen.getByText('кот')).toBeInTheDocument()
    expect(screen.getByText('неизвестен панели')).toBeInTheDocument()
    expect(screen.getByText('привязана')).toBeInTheDocument()
    expect(screen.getByText(/Запрошен сброс облачного пароля/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Показать' })).not.toBeInTheDocument()
  })

  it('remembers the current password once Telegram accepts it', async () => {
    const state = { info: info({ hasPassword: true }) }
    const { calls } = api(state, {
      [`POST ${base}/verify`]: (body) => {
        if ((body as { password: string }).password !== 'right') return json({ error: 'wrong_password', message: 'Неверный текущий пароль' }, 422)
        state.info = info({ hasPassword: true, known: true, hasRecovery: true, recoveryEmail: 'me@example.com' })
        return new Response(null, { status: 204 })
      },
    })
    const user = userEvent.setup()
    renderWithClient(<CloudPasswordCard account={account} />)
    await user.click(await screen.findByRole('button', { name: 'Указать текущий' }))
    const dialog = screen.getByRole('dialog', { name: 'Текущий облачный пароль' })
    await user.type(within(dialog).getByLabelText('Пароль'), 'wrong')
    await user.click(within(dialog).getByRole('button', { name: 'Проверить' }))
    expect(await within(dialog).findByText('Неверный текущий пароль')).toBeInTheDocument()
    await user.clear(within(dialog).getByLabelText('Пароль'))
    await user.type(within(dialog).getByLabelText('Пароль'), 'right')
    await user.click(within(dialog).getByRole('button', { name: 'Проверить' }))
    expect(await screen.findByText('me@example.com')).toBeInTheDocument()
    expect(calls(`POST ${base}/verify`)).toEqual([{ password: 'wrong' }, { password: 'right' }])
  })

  it('shows the stored password only on request', async () => {
    const { fetchMock } = api({ info: info({ hasPassword: true, known: true }) }, { [`GET ${base}`]: () => json({ password: 'kn0wn-pass' }) })
    const user = userEvent.setup()
    renderWithClient(<CloudPasswordCard account={account} />)
    await user.click(await screen.findByRole('button', { name: 'Показать' }))
    expect(await screen.findByText('kn0wn-pass')).toBeInTheDocument()
    expect(fetchMock).toHaveBeenCalledWith(base, expect.anything())
    await user.click(screen.getByRole('button', { name: 'Скрыть' }))
    expect(screen.queryByText('kn0wn-pass')).not.toBeInTheDocument()
  })

  it('sets a first password, checking the repeat', async () => {
    const state = { info: info() }
    const { calls } = api(state, {
      [`PUT ${base}`]: () => {
        state.info = info({ hasPassword: true, known: true, hint: 'кот' })
        return json({ ok: true })
      },
    })
    const user = userEvent.setup()
    renderWithClient(<CloudPasswordCard account={account} />)
    await user.click(await screen.findByRole('button', { name: 'Установить пароль' }))
    const dialog = screen.getByRole('dialog', { name: 'Новый облачный пароль' })
    expect(within(dialog).queryByLabelText('Текущий пароль')).not.toBeInTheDocument()
    await user.type(within(dialog).getByLabelText('Новый пароль'), 'n3w-pass')
    await user.type(within(dialog).getByLabelText('Повтор пароля'), 'n3w-pas')
    await user.type(within(dialog).getByLabelText('Подсказка'), 'кот')
    await user.click(within(dialog).getByRole('button', { name: 'Сохранить' }))
    expect(within(dialog).getByText('Пароли не совпадают')).toBeInTheDocument()
    expect(calls(`PUT ${base}`)).toEqual([])
    await user.type(within(dialog).getByLabelText('Повтор пароля'), 's')
    await user.click(within(dialog).getByRole('button', { name: 'Сохранить' }))
    await waitFor(() => expect(calls(`PUT ${base}`)).toEqual([{ newPassword: 'n3w-pass', hint: 'кот' }]))
    expect(await screen.findByText('установлен')).toBeInTheDocument()
  })

  it('changes it asking for the current one when the panel does not know it, and shows which one was wrong', async () => {
    const { calls } = api({ info: info({ hasPassword: true }) }, { [`PUT ${base}`]: () => json({ error: 'wrong_password', message: 'Неверный текущий пароль' }, 422) })
    const user = userEvent.setup()
    renderWithClient(<CloudPasswordCard account={account} />)
    await user.click(await screen.findByRole('button', { name: 'Сменить пароль' }))
    const dialog = screen.getByRole('dialog', { name: 'Новый облачный пароль' })
    await user.type(within(dialog).getByLabelText('Текущий пароль'), 'old')
    await user.type(within(dialog).getByLabelText('Новый пароль'), 'n3w')
    await user.type(within(dialog).getByLabelText('Повтор пароля'), 'n3w')
    await user.click(within(dialog).getByRole('button', { name: 'Сохранить' }))
    const current = within(dialog).getByLabelText('Текущий пароль')
    await waitFor(() => expect(current).toHaveAttribute('aria-invalid', 'true'))
    expect(within(dialog).getByText('Неверный текущий пароль')).toBeInTheDocument()
    expect(calls(`PUT ${base}`)).toEqual([{ currentPassword: 'old', newPassword: 'n3w' }])
  })

  it('takes the code from the recovery email, or skips the email', async () => {
    const state = { info: info() }
    const { calls } = api(state, {
      [`PUT ${base}`]: () => json({ emailCodeNeeded: { pattern: 'm***@example.com', length: 6 } }),
      [`POST ${base}/email`]: (body) => {
        const b = body as { action: string; code?: string }
        if (b.action === 'confirm' && b.code !== '424242') return json({ error: 'code_invalid', message: 'Неверный код' }, 422)
        state.info = info({ hasPassword: true, known: true, hasRecovery: b.action === 'confirm', recoveryEmail: b.action === 'confirm' ? 'me@example.com' : null })
        return new Response(null, { status: 204 })
      },
    })
    const user = userEvent.setup()
    renderWithClient(<CloudPasswordCard account={account} />)
    await user.click(await screen.findByRole('button', { name: 'Установить пароль' }))
    let dialog = screen.getByRole('dialog', { name: 'Новый облачный пароль' })
    await user.type(within(dialog).getByLabelText('Новый пароль'), 'p')
    await user.type(within(dialog).getByLabelText('Повтор пароля'), 'p')
    await user.type(within(dialog).getByLabelText('Почта для восстановления'), 'me@example.com')
    await user.click(within(dialog).getByRole('button', { name: 'Сохранить' }))

    dialog = await screen.findByRole('dialog', { name: 'Код из письма' })
    expect(within(dialog).getByText(/m\*\*\*@example\.com/)).toBeInTheDocument()
    await user.type(within(dialog).getByLabelText('Код'), '000000')
    await user.click(within(dialog).getByRole('button', { name: 'Подтвердить' }))
    expect(await within(dialog).findByText('Неверный код')).toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: 'Отправить ещё раз' }))
    await user.clear(within(dialog).getByLabelText('Код'))
    await user.type(within(dialog).getByLabelText('Код'), '424242')
    await user.click(within(dialog).getByRole('button', { name: 'Подтвердить' }))
    expect(await screen.findByText('me@example.com')).toBeInTheDocument()
    expect(calls(`POST ${base}/email`)).toEqual([{ action: 'confirm', code: '000000' }, { action: 'resend' }, { action: 'confirm', code: '424242' }])
  })

  it('offers to finish a recovery email that still waits for its code', async () => {
    const { calls } = api({ info: info({ hasPassword: true, known: true, unconfirmedEmailPattern: 'm***@example.com' }) })
    const user = userEvent.setup()
    renderWithClient(<CloudPasswordCard account={account} />)
    expect(await screen.findByText('ожидает подтверждения: m***@example.com')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Ввести код из письма' }))
    const dialog = screen.getByRole('dialog', { name: 'Код из письма' })
    await user.click(within(dialog).getByRole('button', { name: 'Пропустить' }))
    await waitFor(() => expect(calls(`POST ${base}/email`)).toEqual([{ action: 'cancel' }]))
  })

  it('does not ask Telegram while the account is not connected', () => {
    const { fetchMock } = api({ info: info() })
    renderWithClient(<CloudPasswordCard account={accountFixture({ status: 'paused' })} />)
    expect(screen.getByText('Аккаунт не подключён — состояние облачного пароля недоступно')).toBeInTheDocument()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
```

- [ ] **Шаг 2: Убедиться, что тест падает**

```bash
fnm exec --using=26 npx vitest run --project web apps/web/src/components/accounts/cloud-password-card.test.tsx
# FAIL: Failed to resolve import "./cloud-password-card"
```

- [ ] **Шаг 3: Реализация**

`apps/web/src/components/accounts/cloud-password-card.tsx` — новый файл

```tsx
import * as React from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { AccountDto, EmailCodeNeeded } from '@workspace/shared/accounts'
import { Alert, AlertDescription, AlertTitle } from '@workspace/ui/components/alert'
import { Button } from '@workspace/ui/components/button'
import { Spinner } from '@workspace/ui/components/spinner'
import { toast } from '@workspace/ui/components/toast'
import { cloudPasswordInfoQueryOptions } from '@/lib/accounts'
import { api, ApiError } from '@/lib/api'
import { formatDateTime } from '@/lib/format'
import { EmailCodeDialog, SetPasswordDialog, VerifyPasswordDialog } from './cloud-password-dialogs'

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[10rem_1fr] gap-2 py-1.5 text-sm">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </div>
  )
}

/** The account's cloud (2FA) password: what Telegram says, the stored one on request, set / change / verify. */
export function CloudPasswordCard({ account }: { account: AccountDto }) {
  const queryClient = useQueryClient()
  const connected = account.status === 'active' || account.status === 'frozen'
  const query = cloudPasswordInfoQueryOptions(account.id)
  const info = useQuery({ ...query, enabled: connected })
  const [revealed, setRevealed] = React.useState<string | null>(null)
  const [dialog, setDialog] = React.useState<'verify' | 'set' | 'email' | null>(null)
  const [emailStep, setEmailStep] = React.useState<EmailCodeNeeded | null>(null)
  const refresh = () => {
    setRevealed(null)
    void queryClient.invalidateQueries({ queryKey: query.queryKey })
  }

  const reveal = useMutation({
    mutationFn: () => api<{ password: string }>(`/accounts/${account.id}/cloud-password`),
    onSuccess: ({ password }) => setRevealed(password),
    onError: (err) => toast.add({ title: 'Не удалось показать пароль', description: err instanceof ApiError ? err.message : String(err) }),
  })

  if (!connected) return <p className="text-muted-foreground text-sm">Аккаунт не подключён — состояние облачного пароля недоступно</p>
  if (info.isPending) return <Spinner />
  if (info.error) {
    return (
      <Alert variant="destructive">
        <AlertDescription>{info.error.message}</AlertDescription>
      </Alert>
    )
  }
  const s = info.data

  return (
    <div className="flex flex-col gap-4">
      {s.pendingResetAt && (
        <Alert variant="destructive">
          <AlertTitle>Запрошен сброс облачного пароля</AlertTitle>
          <AlertDescription>
            Сброс сработает {formatDateTime(s.pendingResetAt)}. Если это не вы — отмените его в официальном приложении Telegram (Настройки → Конфиденциальность →
            Облачный пароль).
          </AlertDescription>
        </Alert>
      )}
      <dl className="divide-y">
        <Row label="Облачный пароль">{s.hasPassword ? 'установлен' : 'не установлен'}</Row>
        {s.hasPassword && <Row label="Подсказка">{s.hint || '—'}</Row>}
        {s.hasPassword && (
          <Row label="Пароль">
            {s.known ? (
              <span className="flex flex-wrap items-center gap-2">
                <span className="font-mono">{revealed ?? '••••••••'}</span>
                {revealed === null ? (
                  <Button variant="outline" size="sm" disabled={reveal.isPending} onClick={() => reveal.mutate()}>
                    Показать
                  </Button>
                ) : (
                  <Button variant="outline" size="sm" onClick={() => setRevealed(null)}>
                    Скрыть
                  </Button>
                )}
              </span>
            ) : (
              <span className="flex flex-wrap items-center gap-2">
                <span className="text-muted-foreground">неизвестен панели</span>
                <Button variant="outline" size="sm" onClick={() => setDialog('verify')}>
                  Указать текущий
                </Button>
              </span>
            )}
          </Row>
        )}
        {s.hasPassword && (
          <Row label="Почта восстановления">
            <span className="flex flex-col gap-1">
              <span>{s.recoveryEmail ?? (s.hasRecovery ? 'привязана' : 'не привязана')}</span>
              {s.unconfirmedEmailPattern && (
                <span className="flex flex-wrap items-center gap-2">
                  <span className="text-muted-foreground">ожидает подтверждения: {s.unconfirmedEmailPattern}</span>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setEmailStep({ pattern: s.unconfirmedEmailPattern, length: null })
                      setDialog('email')
                    }}
                  >
                    Ввести код из письма
                  </Button>
                </span>
              )}
            </span>
          </Row>
        )}
      </dl>
      <div>
        <Button variant="outline" onClick={() => setDialog('set')}>
          {s.hasPassword ? 'Сменить пароль' : 'Установить пароль'}
        </Button>
      </div>

      <VerifyPasswordDialog accountId={account.id} open={dialog === 'verify'} onOpenChange={(open) => setDialog(open ? 'verify' : null)} onChanged={refresh} />
      <SetPasswordDialog
        accountId={account.id}
        info={s}
        open={dialog === 'set'}
        onOpenChange={(open) => setDialog(open ? 'set' : null)}
        onChanged={refresh}
        onEmailCode={(step) => {
          setEmailStep(step)
          setDialog('email')
        }}
      />
      <EmailCodeDialog accountId={account.id} step={emailStep} open={dialog === 'email'} onOpenChange={(open) => setDialog(open ? 'email' : null)} onChanged={refresh} />
    </div>
  )
}
```

`apps/web/src/components/accounts/cloud-password-dialogs.tsx` — новый файл

```tsx
import * as React from 'react'
import { useMutation } from '@tanstack/react-query'
import type { CloudPasswordInfoDto, EmailCodeNeeded } from '@workspace/shared/accounts'
import { Alert, AlertDescription } from '@workspace/ui/components/alert'
import { Button } from '@workspace/ui/components/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@workspace/ui/components/dialog'
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from '@workspace/ui/components/field'
import { Input } from '@workspace/ui/components/input'
import { Spinner } from '@workspace/ui/components/spinner'
import { toast } from '@workspace/ui/components/toast'
import { PasswordInput } from '@/components/password-input'
import { api, ApiError } from '@/lib/api'

const errorCode = (err: unknown) => (err instanceof ApiError ? (err.body?.error ?? null) : null)
const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err))

interface DialogProps {
  accountId: string
  open: boolean
  onOpenChange: (open: boolean) => void
  /** something changed on Telegram's side: re-read the state */
  onChanged: () => void
}

/** «Указать текущий»: Telegram checks the password, then the panel keeps it. */
export function VerifyPasswordDialog({ accountId, open, onOpenChange, onChanged }: DialogProps) {
  const [password, setPassword] = React.useState('')
  const verify = useMutation({
    mutationFn: () => api(`/accounts/${accountId}/cloud-password/verify`, { method: 'POST', json: { password } }),
    onSuccess: () => {
      toast.add({ title: 'Пароль подошёл — панель его запомнила' })
      onChanged()
      onOpenChange(false)
    },
  })
  const close = (next: boolean) => {
    if (!next) {
      setPassword('')
      verify.reset()
    }
    onOpenChange(next)
  }
  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent>
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault()
            verify.mutate()
          }}
        >
          <DialogHeader>
            <DialogTitle>Текущий облачный пароль</DialogTitle>
            <DialogDescription>Telegram проверит пароль; если он верный, панель его запомнит и покажет в карточке.</DialogDescription>
          </DialogHeader>
          <Field data-invalid={verify.error ? true : undefined}>
            <FieldLabel htmlFor="cloud-verify">Пароль</FieldLabel>
            <PasswordInput id="cloud-verify" autoComplete="off" required value={password} onChange={(e) => setPassword(e.target.value)} aria-invalid={verify.error ? true : undefined} />
            {verify.error && <FieldError>{errorText(verify.error)}</FieldError>}
          </Field>
          <DialogFooter>
            <Button type="submit" disabled={!password || verify.isPending}>
              {verify.isPending && <Spinner data-icon="inline-start" />}
              Проверить
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

/** «Установить» / «Сменить»: new password with a repeat, hint, and an optional recovery email. */
export function SetPasswordDialog({ accountId, info, open, onOpenChange, onChanged, onEmailCode }: DialogProps & { info: CloudPasswordInfoDto; onEmailCode: (step: EmailCodeNeeded) => void }) {
  const askCurrent = info.hasPassword && !info.known
  const empty = { current: '', next: '', repeat: '', hint: '', email: '' }
  const [form, setForm] = React.useState(empty)
  const [mismatch, setMismatch] = React.useState(false)
  const set = (key: keyof typeof empty) => (e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [key]: e.target.value }))

  const save = useMutation({
    mutationFn: () =>
      api<{ ok: true } | { emailCodeNeeded: EmailCodeNeeded }>(`/accounts/${accountId}/cloud-password`, {
        method: 'PUT',
        json: {
          ...(askCurrent ? { currentPassword: form.current } : {}),
          newPassword: form.next,
          ...(form.hint.trim() ? { hint: form.hint.trim() } : {}),
          ...(form.email.trim() ? { email: form.email.trim() } : {}),
        },
      }),
    onSuccess: (result) => {
      onChanged()
      close(false)
      if ('emailCodeNeeded' in result) onEmailCode(result.emailCodeNeeded)
      else toast.add({ title: 'Облачный пароль сохранён' })
    },
    // a stored password that stopped fitting was forgotten: the form will ask for the current one
    onError: (err) => errorCode(err) === 'stale_password' && onChanged(),
  })
  const close = (next: boolean) => {
    if (!next) {
      setForm(empty)
      setMismatch(false)
      save.reset()
    }
    onOpenChange(next)
  }

  const code = errorCode(save.error)
  const currentError = code === 'wrong_password' || code === 'stale_password' || code === 'password_unknown' ? errorText(save.error) : null
  const emailError = code === 'email_invalid' ? errorText(save.error) : null
  const otherError = save.error && !currentError && !emailError ? errorText(save.error) : null

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent>
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault()
            if (form.next !== form.repeat) {
              setMismatch(true)
              return
            }
            setMismatch(false)
            save.mutate()
          }}
        >
          <DialogHeader>
            <DialogTitle>Новый облачный пароль</DialogTitle>
            <DialogDescription>Пароль двухэтапной проверки аккаунта. Панель сохранит его зашифрованным и покажет в карточке.</DialogDescription>
          </DialogHeader>
          <FieldGroup>
            {askCurrent && (
              <Field data-invalid={currentError ? true : undefined}>
                <FieldLabel htmlFor="cloud-current">Текущий пароль</FieldLabel>
                <PasswordInput id="cloud-current" autoComplete="off" required value={form.current} onChange={set('current')} aria-invalid={currentError ? true : undefined} />
                {currentError && <FieldError>{currentError}</FieldError>}
              </Field>
            )}
            <Field>
              <FieldLabel htmlFor="cloud-new">Новый пароль</FieldLabel>
              <PasswordInput id="cloud-new" autoComplete="new-password" required value={form.next} onChange={set('next')} />
            </Field>
            <Field data-invalid={mismatch ? true : undefined}>
              <FieldLabel htmlFor="cloud-repeat">Повтор пароля</FieldLabel>
              <PasswordInput id="cloud-repeat" autoComplete="new-password" required value={form.repeat} onChange={set('repeat')} aria-invalid={mismatch ? true : undefined} />
              {mismatch && <FieldError>Пароли не совпадают</FieldError>}
            </Field>
            <Field>
              <FieldLabel htmlFor="cloud-hint">Подсказка</FieldLabel>
              <Input id="cloud-hint" maxLength={128} value={form.hint} onChange={set('hint')} />
              <FieldDescription>Необязательно. Telegram покажет её при вводе пароля.</FieldDescription>
            </Field>
            <Field data-invalid={emailError ? true : undefined}>
              <FieldLabel htmlFor="cloud-email">Почта для восстановления</FieldLabel>
              <Input id="cloud-email" type="email" autoComplete="off" value={form.email} onChange={set('email')} aria-invalid={emailError ? true : undefined} />
              <FieldDescription>Необязательно. Telegram пришлёт на неё код подтверждения; пусто — почта не меняется.</FieldDescription>
              {emailError && <FieldError>{emailError}</FieldError>}
            </Field>
          </FieldGroup>
          {otherError && (
            <Alert variant="destructive">
              <AlertDescription>{otherError}</AlertDescription>
            </Alert>
          )}
          <DialogFooter>
            <Button type="submit" disabled={!form.next || save.isPending}>
              {save.isPending && <Spinner data-icon="inline-start" />}
              Сохранить
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

/** The code Telegram mailed to the new recovery email: confirm it, send it again, or skip the email. */
export function EmailCodeDialog({ accountId, step, open, onOpenChange, onChanged }: DialogProps & { step: EmailCodeNeeded | null }) {
  const [code, setCode] = React.useState('')
  const act = useMutation({
    mutationFn: (action: 'confirm' | 'resend' | 'cancel') =>
      api(`/accounts/${accountId}/cloud-password/email`, { method: 'POST', json: action === 'confirm' ? { action, code } : { action } }),
    onSuccess: (_, action) => {
      if (action === 'resend') {
        toast.add({ title: 'Письмо отправлено ещё раз' })
        return
      }
      toast.add({ title: action === 'confirm' ? 'Почта подтверждена' : 'Почта не привязана — пароль сохранён' })
      onChanged()
      close(false)
    },
  })
  const close = (next: boolean) => {
    if (!next) {
      setCode('')
      act.reset()
    }
    onOpenChange(next)
  }
  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent>
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault()
            act.mutate('confirm')
          }}
        >
          <DialogHeader>
            <DialogTitle>Код из письма</DialogTitle>
            <DialogDescription>
              Пароль уже действует. Telegram отправил код на {step?.pattern ?? 'почту для восстановления'} — введите его, чтобы привязать почту.
            </DialogDescription>
          </DialogHeader>
          <Field data-invalid={act.error ? true : undefined}>
            <FieldLabel htmlFor="cloud-email-code">Код</FieldLabel>
            <Input id="cloud-email-code" inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} aria-invalid={act.error ? true : undefined} />
            {step?.length ? <FieldDescription>Код из {step.length} цифр</FieldDescription> : null}
            {act.error && <FieldError>{errorText(act.error)}</FieldError>}
          </Field>
          <DialogFooter>
            <Button type="button" variant="ghost" disabled={act.isPending} onClick={() => act.mutate('cancel')}>
              Пропустить
            </Button>
            <Button type="button" variant="outline" disabled={act.isPending} onClick={() => act.mutate('resend')}>
              Отправить ещё раз
            </Button>
            <Button type="submit" disabled={!code.trim() || act.isPending}>
              {act.isPending && <Spinner data-icon="inline-start" />}
              Подтвердить
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
```

`apps/web/src/lib/accounts.ts` — изменения

```diff
--- a/apps/web/src/lib/accounts.ts
+++ b/apps/web/src/lib/accounts.ts
@@ -1,5 +1,5 @@
 import { infiniteQueryOptions, queryOptions } from '@tanstack/react-query'
-import type { AccountDto, AccountSessionDto, AccountStatus, CodeDto } from '@workspace/shared/accounts'
+import type { AccountDto, AccountSessionDto, AccountStatus, CloudPasswordInfoDto, CodeDto } from '@workspace/shared/accounts'
 import type { ProxyDto } from '@workspace/shared/proxies'
 import { api } from './api'
 
@@ -22,6 +22,17 @@ export const accountSessionsQueryOptions = (id: string) =>
     retry: false,
   })
 
+/** Asks the worker (and Telegram) about the account's cloud password. */
+export const cloudPasswordInfoQueryOptions = (id: string) =>
+  queryOptions({
+    queryKey: ['accounts', id, 'cloud-password'] as const,
+    queryFn: ({ signal }) => api<CloudPasswordInfoDto>(`/accounts/${id}/cloud-password/info`, { signal }),
+    retry: false,
+  })
+
+/** Live per-account data the worker fetches from Telegram on demand: not refetched on every account event. */
+export const ON_DEMAND_ACCOUNT_QUERIES = ['sessions', 'cloud-password']
+
 export const codesQueryOptions = (accountId?: string) =>
   queryOptions({
     queryKey: ['codes', accountId ?? 'all'] as const,
```

`apps/web/src/routes/_authed.tsx` — изменения

```diff
--- a/apps/web/src/routes/_authed.tsx
+++ b/apps/web/src/routes/_authed.tsx
@@ -2,7 +2,7 @@ import { useQueryClient } from '@tanstack/react-query'
 import { createFileRoute, Outlet, redirect } from '@tanstack/react-router'
 import { toast } from '@workspace/ui/components/toast'
 import { AppHeader } from '@/components/app-header'
-import { accountsQueryOptions } from '@/lib/accounts'
+import { accountsQueryOptions, ON_DEMAND_ACCOUNT_QUERIES } from '@/lib/accounts'
 import { emitAppEvent } from '@/lib/app-events'
 import { meQueryOptions, recheckSession } from '@/lib/auth'
 import { proxiesQueryOptions } from '@/lib/proxies'
@@ -28,11 +28,11 @@ function AuthedLayout() {
         if (event.by !== me.id) toast.add({ title: 'Настройки изменены', description: 'Другой админ или CLI обновил настройки.' })
       }
       if (event.type === 'proxies.changed') void queryClient.invalidateQueries({ queryKey: proxiesQueryOptions.queryKey })
-      // the list and the cards (['accounts', id]); sessions are re-read only on demand
-      if (event.type === 'accounts.changed') void queryClient.invalidateQueries({ queryKey: accountsQueryOptions.queryKey, predicate: (q) => q.queryKey[2] !== 'sessions' })
+      // the list and the cards (['accounts', id]); sessions and the cloud password are re-read only on demand
+      if (event.type === 'accounts.changed') void queryClient.invalidateQueries({ queryKey: accountsQueryOptions.queryKey, predicate: (q) => !ON_DEMAND_ACCOUNT_QUERIES.includes(String(q.queryKey[2])) })
       if (event.type === 'code.new') {
         void queryClient.invalidateQueries({ queryKey: ['codes'] })
-        void queryClient.invalidateQueries({ queryKey: accountsQueryOptions.queryKey, predicate: (q) => q.queryKey[2] !== 'sessions' })
+        void queryClient.invalidateQueries({ queryKey: accountsQueryOptions.queryKey, predicate: (q) => !ON_DEMAND_ACCOUNT_QUERIES.includes(String(q.queryKey[2])) })
       }
       emitAppEvent(event)
     },
```

`apps/web/src/routes/_authed/accounts/$id.tsx` — изменения

```diff
--- a/apps/web/src/routes/_authed/accounts/$id.tsx
+++ b/apps/web/src/routes/_authed/accounts/$id.tsx
@@ -12,6 +12,7 @@ import { AccountNotesForm } from '@/components/accounts/account-notes-form'
 import { AccountRouteForm } from '@/components/accounts/account-route-form'
 import { AccountSessions } from '@/components/accounts/account-sessions'
 import { AccountStatusBadge } from '@/components/accounts/account-status-badge'
+import { CloudPasswordCard } from '@/components/accounts/cloud-password-card'
 import { DeleteAccountDialog } from '@/components/accounts/delete-account-dialog'
 import { CodesTable } from '@/components/codes/codes-table'
 import { PageHeader } from '@/components/page-header'
@@ -181,6 +182,15 @@ function AccountPage() {
           </Card>
         </div>
       </div>
+      <Card>
+        <CardHeader>
+          <CardTitle>Облачный пароль</CardTitle>
+          <CardDescription>Пароль двухэтапной проверки: состояние от Telegram, сам пароль — если панель его знает.</CardDescription>
+        </CardHeader>
+        <CardContent>
+          <CloudPasswordCard key={a.id} account={a} />
+        </CardContent>
+      </Card>
       <Card>
         <CardHeader>
           <CardTitle>Активные сессии</CardTitle>
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
feat(web): cloud password in the account card — state from Telegram, pending-reset warning, stored password on request, verify, set/change with repeat and hint, recovery email code (confirm, resend, skip); not refetched on every account event
MSG
```

---

### Task 9: e2e и документация

e2e без Telegram: вкладка «По номеру» без своего api_id показывает понятную ошибку.

AGENTS.md:
- оба входа и общий модуль;
- почему Desktop-only аккаунтам нужен вход по номеру;
- хранение и показ облачного пароля;
- подводный камень `drizzle-kit` со скрытым hoist pnpm;
- статус плана 3.

Описание страницы «Аккаунты» упоминает вход по номеру.

**Files:**
- Modify: `apps/web/src/routes/_authed/accounts/index.tsx`
- Test (modify): `e2e/telegram.spec.ts`
- Modify: `AGENTS.md`

**Interfaces:**
- Consumes: всё из задач 7–8.

- [ ] **Шаг 1: Написать падающий тест**

`e2e/telegram.spec.ts` — изменения

```diff
--- a/e2e/telegram.spec.ts
+++ b/e2e/telegram.spec.ts
@@ -45,3 +45,17 @@ test('QR login explains that it needs an own api_id', async ({ page, isMobile })
   await dialog.getByRole('button', { name: 'Показать QR-код' }).click()
   await expect(dialog.getByText('Для входа по QR нужен свой api_id и api_hash (Настройки → Telegram)')).toBeVisible()
 })
+
+test('login by phone explains that it needs an own api_id', async ({ page, isMobile }) => {
+  await signIn(page)
+  await goToSection(page, 'Аккаунты', isMobile)
+  await page.getByRole('button', { name: 'Добавить аккаунт' }).click()
+  const dialog = page.getByRole('dialog', { name: 'Новый аккаунт' })
+  await dialog.getByRole('tab', { name: 'По номеру' }).click()
+  await dialog.getByLabel('Подключение').click()
+  await page.getByRole('option', { name: 'Напрямую, без прокси' }).click()
+  await dialog.getByLabel('Номер телефона').fill('+7 700 123 45 67')
+  await dialog.getByRole('button', { name: 'Получить код' }).click()
+  await expect(dialog.getByText('Для входа по номеру нужен свой api_id и api_hash (Настройки → Telegram)')).toBeVisible()
+})
+
```

- [ ] **Шаг 2: Прогнать новый e2e (он закрепляет готовое поведение задачи 7)**

```bash
E2E_BASE_URL=http://localhost:5173 E2E_LOGIN=<логин> E2E_PASSWORD=<пароль> fnm exec --using=26 pnpm e2e
# новый тест проходит сразу: поведение сделано в задаче 7, здесь оно закрепляется e2e
```

- [ ] **Шаг 3: Реализация**

`apps/web/src/routes/_authed/accounts/index.tsx` — изменения

```diff
--- a/apps/web/src/routes/_authed/accounts/index.tsx
+++ b/apps/web/src/routes/_authed/accounts/index.tsx
@@ -129,7 +129,7 @@ function AccountsPage() {
 
   return (
     <div className="flex flex-col gap-6">
-      <PageHeader title="Аккаунты" description="Telegram-аккаунты панели: перенесённые из tdata и вошедшие по QR." actions={<AddAccountDialog />} />
+      <PageHeader title="Аккаунты" description="Telegram-аккаунты панели: перенесённые из tdata и вошедшие новой сессией — по QR или по номеру." actions={<AddAccountDialog />} />
       <div className="flex flex-wrap items-end gap-4">
         <Field className="w-auto">
           <FieldLabel>Статус</FieldLabel>
```

`AGENTS.md` — изменения

```diff
--- a/AGENTS.md
+++ b/AGENTS.md
@@ -47,7 +47,7 @@ apps/api        Hono API + CLI (src/main.ts, src/app.ts, src/cli.ts; routes/, mi
 apps/worker     воркер: lock.ts (advisory lock), runtime.ts + schedule.ts (BullMQ: команды и периодические задачи),
                 proxies/ (проверки, proxy-store), telegram/ (сессия mtcute, хранилище, классификация ошибок),
                 accounts/manager.ts (жизненный цикл клиентов), codes/ (сбор из @VerificationCodes), notify/ (бот),
-                qr/ (вход по QR), housekeeping.ts
+                qr/ (вход по QR), login/ (вход по номеру и общее для входов), housekeeping.ts
 apps/web        SPA (routes/ — TanStack file routes, components/, lib/{api,auth,router,query-client,use-event-stream,…})
 packages/shared без IO, импортируется и вебом: env, duration, crypto (AES-256-GCM), api DTO, events,
                 settings/ (реестр настроек: types, helpers, groups, definitions, units, format, validate)
@@ -129,6 +129,10 @@ CLI (`apps/api/src/cli.ts`): `admin:create|admin:reset-password|admin:disable --
   `drizzle-orm`: опциональный peer `better-sqlite3` у `@mtcute/node` порождает вторую копию drizzle с
   несовместимыми типами. В `pnpm-workspace.yaml` сборки `better-sqlite3` и `msgpackr-extract` запрещены
   (`allowBuilds: false`).
+- Если `drizzle-kit generate` пишет «Please install latest version of drizzle-orm»: он импортирует
+  `drizzle-orm/version` через скрытый hoist `node_modules/.pnpm/node_modules/drizzle-orm`. Hoist мог достаться
+  варианту `drizzle-orm` с `better-sqlite3` — направьте ссылку на вариант `…_pg@…` и повторите. Это локальная
+  правка окружения, не коммит.
 
 ## Воркер и Telegram
 
@@ -157,8 +161,25 @@ CLI (`apps/api/src/cli.ts`): `admin:create|admin:reset-password|admin:disable --
 - Прокси: дешёвая проверка — TCP-туннель до DC2 через прокси каждые N минут; раз в сутки — MTProto
   `help.getNearestDc`, ради страны, которую видит Telegram (194.53.188.x — KZ, 194.53.189.x — JP; страна только
   показывается). Один прокси — один аккаунт (unique). «Напрямую» — только явным выбором админа.
-- Вход по QR требует своего api_id/api_hash (`telegram.own.*`); пароль 2FA идёт в воркер через Redis pub/sub
-  (`accs:qr:<id>`), не сохраняется и не пишется в аудит.
+- Вход по QR и по номеру требует своего api_id/api_hash (`telegram.own.*`). Секреты входа идут в воркер через
+  Redis pub/sub, не сохраняются и не пишутся в аудит:
+  - QR — пароль 2FA через `accs:qr:<id>`;
+  - номер — код, пароль, «отправить ещё раз», отмена через `accs:login:<id>`.
+
+  Оба входа завершаются в `login/common.ts`:
+  - аккаунт уже в панели — новая сессия выходит;
+  - иначе аккаунт сохраняется с session string и введённым облачным паролем;
+  - клиент входа уничтожается до старта аккаунта.
+
+  Telegram Desktop не умеет подтверждать QR-вход (`auth.acceptLoginToken` в tdesktop не вызывается), поэтому
+  для аккаунтов только с Desktop — вход по номеру: код приходит в Desktop от «Telegram».
+- Облачный пароль хранится в `accounts.cloud_password_enc`, зашифрованным.
+  - Пишет его только воркер и только после того, как Telegram пароль принял: вход, «Указать текущий», установка или смена.
+  - Команды `account.password.*` несут секреты только полями `…Enc`.
+  - Показать пароль — аудируемый `GET /accounts/:id/cloud-password`.
+  - Состояние 2FA (подсказка, почта восстановления, отложенный сброс) не хранится: `account.password.info` спрашивает Telegram при открытии карточки.
+  - Адрес почты восстановления Telegram отдаёт только при известном пароле (`account.getPasswordSettings`).
+  - Веб не перезапрашивает «живые» данные аккаунта на каждое событие (`ON_DEMAND_ACCOUNT_QUERIES`).
 - Логи воркера для эксплуатации: `accounts: connected`, `codes: watching @VerificationCodes` (`caughtUp`),
   `accounts: client error`. Телефоны и ключи в логи не пишутся.
 
@@ -220,6 +241,10 @@ CLI (`apps/api/src/cli.ts`): `admin:create|admin:reset-password|admin:disable --
   профиль, сессии, заморозка, коды из @VerificationCodes, уведомления в канал. Живая проверка на архиве из
   `tdata-samples/` через KZ-прокси: подключение, профиль и сессии подтверждены; приход настоящего кода в ленту и канал
   ещё не наблюдался (задача 19, шаг 4).
+- **План 3 «Вход по номеру и облачный пароль»** (`docs/superpowers/plans/2026-10-03-plan-3-phone-login-cloud-password.md`,
+  спека `docs/superpowers/specs/2026-10-03-phone-login-cloud-password-design.md`):
+  - вкладка «По номеру» с кодом и облачным паролем;
+  - в карточке аккаунта — облачный пароль: состояние, показ, «Указать текущий», установка и смена с почтой восстановления.
 - Планы пишутся перед реализацией (скилл writing-plans) от спеки `docs/superpowers/specs/2026-10-03-accs-manager-design.md`.
   Отложенные пункты из ревью плана 1 перечислены в итогах сессии (раздел «Что дальше»).
```

- [ ] **Шаг 4: Проверки**

```bash
fnm exec --using=26 pnpm typecheck
fnm exec --using=26 pnpm lint
fnm exec --using=26 npx tsc -p e2e/tsconfig.json
E2E_BASE_URL=http://localhost:5173 E2E_LOGIN=<логин> E2E_PASSWORD=<пароль> fnm exec --using=26 pnpm e2e   # против pnpm dev: 18 passed
# всё зелёное
```

- [ ] **Шаг 5: Коммит**

```bash
git add -A
git commit -F - <<'MSG'
chore: e2e for login by phone, docs for phone login and the cloud password
MSG
```

---

### Task 10: Живая проверка

Ручная проверка на настоящем Telegram, коммита нет. Нашлось что-то — исправление с тестом в задаче-владельце, отдельным коммитом.

- [ ] **Шаг 1: Свой api_id**

В «Настройках → Telegram» задать `telegram.own.apiId` и `telegram.own.apiHash` с my.telegram.org. Вводит владелец.

- [ ] **Шаг 2: Вход по номеру на аккаунте, где открыт только Telegram Desktop**

1. Если аккаунт уже есть в панели — «Удалить» без «Завершить сессию в Telegram».
2. «Добавить аккаунт → По номеру», подключение — KZ-прокси `194.53.188.x`, номер аккаунта, «Получить код».

Ожидание:
- «Код отправлен в приложение Telegram — сообщением от «Telegram»»; код приходит в Desktop.
- После кода (и облачного пароля, если он включён) открывается карточка: статус «активен», источник «вход по номеру».
- В «Активных сессиях» есть сессия панели со своим api_id.
- В блоке «Облачный пароль» пароль известен панели, если его вводили при входе.

- [ ] **Шаг 3: Облачный пароль — только на аккаунте, который назовёт владелец**

1. «Указать текущий» — если пароль есть, но неизвестен.
2. «Сменить пароль» / «Установить пароль» с почтой: приходит письмо с кодом, «Подтвердить» привязывает почту.

На только что добавленной сессии ожидаемо «Telegram пока не даёт менять пароль с этой сессии — подождите N ч». Это закреплённое поведение, а не сбой.

## После плана 3

1. Финальное ревью ветки, слияние и деплой — по решению владельца. После деплоя на проде — `db:migrate` выполняет `accs-migrate` сам.
2. Не забыть: живая проверка прихода кода из @VerificationCodes (план 2, задача 19, шаг 4) всё ещё открыта.
