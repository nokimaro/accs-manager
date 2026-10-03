import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { createCipher } from '../src/crypto.ts'

const key = randomBytes(32).toString('base64')

describe('createCipher', () => {
  it('round-trips text, including empty and unicode', () => {
    const c = createCipher(key)
    for (const s of ['', 'secret', 'Пароль ✓', 'x'.repeat(10_000)]) expect(c.decrypt(c.encrypt(s))).toBe(s)
  })

  it('uses the v1 format with a fresh IV each time', () => {
    const c = createCipher(key)
    const a = c.encrypt('same')
    const b = c.encrypt('same')
    expect(a).toMatch(/^v1:[^:]+:[^:]*:[^:]+$/)
    expect(a).not.toBe(b)
  })

  it('detects tampering', () => {
    const c = createCipher(key)
    const [v, iv, ct, tag] = c.encrypt('hello').split(':') as [string, string, string, string]
    const flipped = Buffer.from(ct, 'base64')
    flipped[0] = (flipped[0] ?? 0) ^ 1
    expect(() => c.decrypt([v, iv, flipped.toString('base64'), tag].join(':'))).toThrow()
  })

  it('fails with another key', () => {
    const token = createCipher(key).encrypt('hello')
    expect(() => createCipher(randomBytes(32).toString('base64')).decrypt(token)).toThrow()
  })

  it('rejects unknown versions and bad keys', () => {
    const c = createCipher(key)
    expect(() => c.decrypt('v2:a:b:c')).toThrow(/Unsupported/)
    expect(() => createCipher(randomBytes(16).toString('base64'))).toThrow(/32 bytes/)
  })
})
