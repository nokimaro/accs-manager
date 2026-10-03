import { settings as settingsTable, type Db } from '@workspace/db'
import type { SettingStateDto } from '@workspace/shared/api'
import type { Cipher } from '@workspace/shared/crypto'
import {
  isSettingKey,
  settingsDef,
  validateSettingChanges,
  type SettingKey,
  type SettingsValues,
} from '@workspace/shared/settings'
import { eq } from 'drizzle-orm'
import type { EventBus } from './bus.ts'
import type { Logger } from './logger.ts'

type Listener = (value: unknown, previous: unknown) => void

interface Entry {
  value: unknown
  overridden: boolean
  updatedAt: Date | null
  updatedBy: string | null
}

export interface SettingDiff {
  key: SettingKey
  /** secrets are reported as '[redacted]' */
  from: unknown
  to: unknown
}

export type SettingsUpdateResult = { ok: true; diff: SettingDiff[] } | { ok: false; errors: Record<string, string> }

const REDACTED = '[redacted]'
const allKeys = Object.keys(settingsDef) as SettingKey[]
const isSecret = (key: SettingKey) => settingsDef[key].meta.type === 'secret'

/**
 * Typed, DB-backed settings with an in-memory cache. Every process (api, worker) owns one
 * instance; `settings.changed` on the bus makes all instances reload, so changes apply
 * without restarts.
 */
export class SettingsService {
  readonly #db: Db
  readonly #cipher: Cipher
  readonly #bus: EventBus
  readonly #logger: Logger | undefined
  #entries = new Map<SettingKey, Entry>()
  readonly #listeners = new Map<SettingKey, Set<Listener>>()
  #unsubscribe: (() => void) | undefined
  #reloadChain: Promise<void> = Promise.resolve()

  private constructor(db: Db, cipher: Cipher, bus: EventBus, logger: Logger | undefined) {
    this.#db = db
    this.#cipher = cipher
    this.#bus = bus
    this.#logger = logger
  }

  static async create(options: { db: Db; cipher: Cipher; bus: EventBus; logger?: Logger }): Promise<SettingsService> {
    const service = new SettingsService(options.db, options.cipher, options.bus, options.logger)
    const reload = () => service.reload().catch((err: unknown) => service.#logger?.error({ err }, 'settings: reload failed'))
    // subscribe before the first load so a change published in between is not lost
    const offChanged = options.bus.subscribe((event) => {
      if (event.type === 'settings.changed') void reload()
    })
    // a change broadcast while Redis was unreachable never arrives: re-read everything after a reconnect
    const offReconnect = options.bus.onReconnect(() => void reload())
    service.#unsubscribe = () => {
      offChanged()
      offReconnect()
    }
    await service.reload()
    return service
  }

  get<K extends SettingKey>(key: K): SettingsValues[K] {
    return (this.#entries.get(key)?.value ?? settingsDef[key].default) as SettingsValues[K]
  }

  /** Called after a reload changes the effective value (in this process). */
  onChange<K extends SettingKey>(key: K, listener: (value: SettingsValues[K], previous: SettingsValues[K]) => void): () => void {
    const set = this.#listeners.get(key) ?? new Set<Listener>()
    set.add(listener as Listener)
    this.#listeners.set(key, set)
    return () => set.delete(listener as Listener)
  }

  /** State for the admin UI; secret values are never included. */
  snapshot(): Record<SettingKey, SettingStateDto> {
    const out = {} as Record<SettingKey, SettingStateDto>
    for (const key of allKeys) {
      const entry = this.#entries.get(key)
      const value = this.get(key)
      out[key] = {
        value: isSecret(key) ? null : value,
        isSet: value !== null,
        overridden: entry?.overridden ?? false,
        updatedAt: entry?.updatedAt?.toISOString() ?? null,
        updatedBy: entry?.updatedBy ?? null,
      }
    }
    return out
  }

  /** Validates, writes atomically, reloads and broadcasts. `null` removes the override. */
  async update(input: Record<string, unknown>, by: { adminId: string | null }): Promise<SettingsUpdateResult> {
    const validated = validateSettingChanges(input)
    if (!validated.ok) return validated

    const diff: SettingDiff[] = []
    await this.#db.transaction(async (tx) => {
      for (const [key, value] of validated.changes) {
        const from = this.get(key)
        if (value === null) {
          await tx.delete(settingsTable).where(eq(settingsTable.key, key))
        } else {
          const stored = isSecret(key) ? { enc: this.#cipher.encrypt(value as string) } : value
          await tx
            .insert(settingsTable)
            .values({ key, value: stored, updatedBy: by.adminId })
            .onConflictDoUpdate({
              target: settingsTable.key,
              set: { value: stored, updatedAt: new Date(), updatedBy: by.adminId },
            })
        }
        const to = value ?? settingsDef[key].default
        diff.push(isSecret(key) ? { key, from: REDACTED, to: to === null ? null : REDACTED } : { key, from, to })
      }
    })

    // the write is committed: a failing local reload or broadcast must not turn it into an error
    try {
      await this.reload()
    } catch (err) {
      this.#logger?.error({ err }, 'settings: reload after update failed')
    }
    try {
      await this.#bus.publish({ type: 'settings.changed', keys: diff.map((d) => d.key), by: by.adminId })
    } catch (err) {
      this.#logger?.error({ err }, 'settings: publish failed; other processes reload on the next change')
    }
    return { ok: true, diff }
  }

  async #load(): Promise<void> {
    const rows = await this.#db.select().from(settingsTable)
    const next = new Map<SettingKey, Entry>()
    for (const row of rows) {
      if (!isSettingKey(row.key)) continue
      const value = this.#decode(row.key, row.value)
      if (value === undefined) continue
      next.set(row.key, { value, overridden: true, updatedAt: row.updatedAt, updatedBy: row.updatedBy })
    }
    const previous = this.#entries
    this.#entries = next
    for (const key of allKeys) {
      const before = previous.get(key)?.value ?? settingsDef[key].default
      const after = next.get(key)?.value ?? settingsDef[key].default
      if (JSON.stringify(before) === JSON.stringify(after)) continue
      for (const listener of this.#listeners.get(key) ?? []) {
        try {
          listener(after, before)
        } catch (err) {
          this.#logger?.error({ err, key }, 'settings: listener failed')
        }
      }
    }
  }

  /** Reloads are serialized: overlapping calls (own update + bus echo) apply in order, never stale over fresh. */
  reload(): Promise<void> {
    const run = this.#reloadChain.then(() => this.#load())
    this.#reloadChain = run.catch(() => undefined)
    return run
  }

  close(): void {
    this.#unsubscribe?.()
  }

  /** Returns undefined (→ default) when a stored value can't be decrypted or no longer validates. */
  #decode(key: SettingKey, stored: unknown): unknown {
    try {
      let raw = stored
      if (isSecret(key)) {
        if (typeof stored !== 'object' || stored === null || typeof (stored as { enc?: unknown }).enc !== 'string') {
          throw new Error('secret is not encrypted')
        }
        raw = this.#cipher.decrypt((stored as { enc: string }).enc)
      }
      const parsed = settingsDef[key].schema.safeParse(raw)
      if (parsed.success) return parsed.data
      this.#logger?.warn({ key }, 'settings: stored value is invalid, using default')
    } catch (err) {
      this.#logger?.warn({ key, err }, 'settings: stored value is unreadable, using default')
    }
    return undefined
  }
}
