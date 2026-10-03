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
    await expect(cliRun(['settings:set', 'notify.botToken', '9:LEAK'])).rejects.toMatchObject({ stderr: expect.stringMatching(/--value-stdin/) })
    const audits = await t.db.select().from(auditLog).where(eq(auditLog.action, 'settings.update'))
    expect(audits.length).toBeGreaterThanOrEqual(2)
    expect(audits.every((a) => a.actorType === 'cli')).toBe(true)
    expect(JSON.stringify(audits.map((a) => a.payload))).not.toContain('123:SECRET')
    await cliRun(['settings:reset', 'worker.connectConcurrency'])
    expect((await cliRun(['settings:get', 'worker.connectConcurrency'])).stdout).toMatch(/= 5 {2}\(default\)/)
    await expect(cliRun(['settings:set', 'worker.connectConcurrency', '0'])).rejects.toMatchObject({ stderr: expect.stringMatching(/Не меньше 1/) })
  })
})
