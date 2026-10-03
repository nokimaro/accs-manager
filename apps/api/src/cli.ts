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

<value> is converted by the setting's type: int → number, bool → true | false,
multiselect → a,b,c or a JSON array; everything else is taken as a string.
It may start with '-' (e.g. -1001234567890); '--' before it works as well.
Secret settings are accepted only via --value-stdin.`

const OPTIONS = {
  login: { type: 'string' },
  'password-stdin': { type: 'boolean' },
  'value-stdin': { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
} as const

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

/**
 * `settings:set <key> <value>`: a value starting with a single '-' (a channel id like -1001234567890)
 * is set aside before option parsing, which would reject it as an unknown short option.
 */
function parseCommandLine(argv: string[]) {
  const [command, key, value] = argv
  const dashValue = command === 'settings:set' && key !== undefined && !key.startsWith('-') && value !== undefined && /^-(?!-)/.test(value)
  let parsed
  try {
    parsed = parseArgs({ args: dashValue ? argv.toSpliced(2, 1) : argv, allowPositionals: true, options: OPTIONS })
  } catch (err) {
    throw new CliError(`${(err as Error).message}\n\n${USAGE}`)
  }
  return { values: parsed.values, positionals: dashValue ? parsed.positionals.toSpliced(2, 0, value) : parsed.positionals }
}

/** Converts a raw CLI string to the setting's declared type; the setting schema then validates it. */
function parseValue(key: string, raw: string): unknown {
  if (!isSettingKey(key)) return raw
  switch (settingsDef[key].meta.type) {
    case 'int':
      return /^-?\d+$/.test(raw.trim()) ? Number(raw) : raw
    case 'bool':
      return raw === 'true' ? true : raw === 'false' ? false : raw
    case 'multiselect':
      if (raw.trim().startsWith('[')) {
        try {
          return JSON.parse(raw)
        } catch {
          return raw
        }
      }
      return raw
        .split(',')
        .map((v) => v.trim())
        .filter(Boolean)
    default:
      // string, text, decimal, duration, select, secret
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
  const { positionals, values } = parseCommandLine(argv)
  const [command, ...args] = positionals
  if (!command || values.help) {
    console.log(USAGE)
    return
  }

  let env: Env
  try {
    env = loadEnv()
  } catch (err) {
    throw new CliError((err as Error).message)
  }
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
          if (values['value-stdin']) value = parseValue(key, await readStdin())
          else if (rawValue !== undefined) {
            if (isSettingKey(key) && settingsDef[key].meta.type === 'secret') {
              throw new CliError('secret values must be passed via --value-stdin, never as an argument')
            }
            value = parseValue(key, rawValue)
          } else throw new CliError('value is required')
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
