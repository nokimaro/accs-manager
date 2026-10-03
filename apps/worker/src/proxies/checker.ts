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
