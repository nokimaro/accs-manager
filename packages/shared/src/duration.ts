const UNIT_MS = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const

export type DurationUnit = keyof typeof UNIT_MS

const DURATION_RE = /^(\d+)(s|m|h|d)$/

/** '5m' → 300000. Throws on invalid input. */
export function parseDuration(value: string): number {
  const match = DURATION_RE.exec(value)
  if (!match) throw new Error(`Invalid duration: "${value}" (expected e.g. 30s, 5m, 6h, 7d)`)
  return Number(match[1]) * UNIT_MS[match[2] as DurationUnit]
}

export function isDuration(value: string): boolean {
  return DURATION_RE.test(value)
}

/** 300000 → '5m'; picks the largest unit that divides evenly. */
export function formatDuration(ms: number): string {
  if (!Number.isInteger(ms) || ms < 0) throw new Error(`Invalid milliseconds: ${ms}`)
  const units: DurationUnit[] = ['d', 'h', 'm', 's']
  for (const unit of units) {
    if (ms % UNIT_MS[unit] === 0 && ms >= UNIT_MS[unit]) return `${ms / UNIT_MS[unit]}${unit}`
  }
  if (ms === 0) return '0s'
  throw new Error(`Milliseconds not representable in whole seconds: ${ms}`)
}

/** «10 мин», «2 ч»: how long Telegram asks to wait, rounded up; hours from one hour on. */
export function formatWait(seconds: number): string {
  return seconds < 3_600 ? `${Math.max(1, Math.ceil(seconds / 60))} мин` : `${Math.ceil(seconds / 3_600)} ч`
}
