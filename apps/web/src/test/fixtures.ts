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
