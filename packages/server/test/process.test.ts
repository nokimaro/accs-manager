import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'

const run = promisify(execFile)
const cwd = fileURLToPath(new URL('..', import.meta.url))

/** Runs a module that installs the handlers, then fails in the given way; returns exit code and stdout. */
async function crash(failure: string): Promise<{ code: number | null; stdout: string }> {
  const script = `
    import { createLogger } from './src/logger.ts'
    import { exitOnFatalErrors } from './src/process.ts'
    exitOnFatalErrors(createLogger({ level: 'info', name: 'probe' }))
    ${failure}
  `
  try {
    const { stdout } = await run(process.execPath, ['--input-type=module', '-e', script], { cwd })
    return { code: 0, stdout }
  } catch (err) {
    const { code, stdout } = err as { code: number | null; stdout: string }
    return { code, stdout }
  }
}

describe('exitOnFatalErrors', () => {
  it.each([
    ['an uncaught exception', "setTimeout(() => { throw new Error('boom') })", 'uncaught exception'],
    ['an unhandled rejection', "Promise.reject(new Error('boom'))", 'unhandled rejection'],
  ])('logs %s as one fatal JSON line, then exits with 1', async (_case, failure, msg) => {
    const { code, stdout } = await crash(failure)
    expect(code).toBe(1)
    const line = JSON.parse(stdout.trim().split('\n').at(-1)!) as { level: number; msg: string; err: { message: string } }
    expect(line).toMatchObject({ level: 60, msg, err: { message: 'boom' } })
  })
})
