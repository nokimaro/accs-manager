import { accounts, eq } from '@workspace/db'
import type { TestCodeDto } from '@workspace/shared/accounts'
import { formatWait } from '@workspace/shared/duration'
import type { AppDeps } from '../deps.ts'
import { DomainError } from '../lib/errors.ts'
import { createGateway, GatewayError, type GatewayRequestStatus } from '../lib/telegram-gateway.ts'

/** how long the test message lives; not delivered or read by then — Gateway refunds it */
const TTL_SECONDS = 300

type Deps = Pick<AppDeps, 'db' | 'settings' | 'fetch'>

function gatewayFor(deps: Deps) {
  const token = deps.settings.get('gateway.token')
  if (!token) throw new DomainError(409, 'gateway_token_missing', 'Задайте токен Telegram Gateway: Настройки → Telegram Gateway')
  return createGateway(token, deps.fetch)
}

async function phoneOf(deps: Deps, accountId: string): Promise<string> {
  const [account] = await deps.db.select({ phone: accounts.phone }).from(accounts).where(eq(accounts.id, accountId))
  if (!account) throw new DomainError(404, 'not_found', 'Аккаунт не найден')
  if (!account.phone) throw new DomainError(409, 'no_phone', 'Номер аккаунта ещё неизвестен — дождитесь подключения')
  return account.phone
}

/** Gateway's refusals in words; anything unexpected keeps its code so it can be looked up. */
function explain(err: unknown): never {
  if (!(err instanceof GatewayError)) {
    throw new DomainError(503, 'gateway_unreachable', 'Telegram Gateway не ответил — попробуйте ещё раз')
  }
  const flood = /^FLOOD_WAIT_(\d+)$/.exec(err.code)
  if (flood) throw new DomainError(409, 'gateway_flood', `Слишком много попыток для этого номера — повторите через ${formatWait(Number(flood[1]))}`)
  switch (err.code) {
    case 'PHONE_NUMBER_NOT_AVAILABLE':
      throw new DomainError(
        409,
        'gateway_not_available',
        'Telegram не доставит код на этот номер: аккаунт давно не был в сети. Проверьте, что включено «Держать аккаунты „в сети“», переподключите аккаунт и попробуйте через минуту',
      )
    case 'ACCESS_TOKEN_INVALID':
    case 'ACCESS_TOKEN_REQUIRED':
      throw new DomainError(409, 'gateway_token_invalid', 'Telegram Gateway не принял токен — проверьте его в Настройках')
    case 'BALANCE_NOT_ENOUGH':
      throw new DomainError(409, 'gateway_balance', 'На балансе Telegram Gateway не хватает средств')
    case 'REQUEST_ID_INVALID':
      throw new DomainError(404, 'not_found', 'Такой отправки в Telegram Gateway нет')
    default:
      throw new DomainError(409, 'gateway_error', `Telegram Gateway отказал: ${err.code}`)
  }
}

const toDto = (s: GatewayRequestStatus): TestCodeDto => ({ requestId: s.requestId, delivery: s.delivery, cost: s.cost, remainingBalance: s.remainingBalance })

/** A new verification message to the account's own number: the code shows up in @VerificationCodes and in the feed. */
export async function sendTestCode(deps: Deps, accountId: string): Promise<TestCodeDto> {
  const phone = await phoneOf(deps, accountId)
  const gateway = gatewayFor(deps)
  return toDto(await gateway.sendVerificationMessage(`+${phone}`, TTL_SECONDS).catch(explain))
}

/** Delivery of an earlier test code; only for a request that went to this account's number. */
export async function testCodeStatus(deps: Deps, accountId: string, requestId: string): Promise<TestCodeDto> {
  const phone = await phoneOf(deps, accountId)
  const status = await gatewayFor(deps).checkVerificationStatus(requestId).catch(explain)
  if (status.phoneNumber.replace(/^\+/, '') !== phone) throw new DomainError(404, 'not_found', 'Такой отправки для этого аккаунта нет')
  return toDto(status)
}
