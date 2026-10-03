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
