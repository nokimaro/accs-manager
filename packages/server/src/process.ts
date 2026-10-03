import type { Logger } from './logger.ts'

/**
 * Last-resort handlers for long-running processes (api, worker): log the fatal error as one
 * structured line, then exit non-zero so the container restarts.
 */
export function exitOnFatalErrors(logger: Logger): void {
  process.on('uncaughtException', (err) => {
    logger.fatal({ err }, 'uncaught exception')
    process.exit(1)
  })
  process.on('unhandledRejection', (reason) => {
    logger.fatal({ err: reason }, 'unhandled rejection')
    process.exit(1)
  })
}
