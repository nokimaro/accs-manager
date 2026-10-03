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
