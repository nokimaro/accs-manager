import { describe, expect, it } from 'vitest'
import { loadEnv } from '../src/env.ts'

const valid = {
  DATABASE_URL: 'postgres://u:p@localhost:5432/db',
  REDIS_URL: 'redis://localhost:6379',
  APP_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
  PUBLIC_ORIGIN: 'https://panel.example.com',
}

describe('loadEnv', () => {
  it('applies defaults', () => {
    const env = loadEnv(valid)
    expect(env).toMatchObject({ NODE_ENV: 'development', PORT: 3000, TRUST_PROXY: false, LOG_LEVEL: 'info' })
  })

  it('parses TRUST_PROXY and PORT from strings', () => {
    const env = loadEnv({ ...valid, TRUST_PROXY: 'true', PORT: '8080' })
    expect(env.TRUST_PROXY).toBe(true)
    expect(env.PORT).toBe(8080)
  })

  it('rejects a key that is not 32 bytes', () => {
    expect(() => loadEnv({ ...valid, APP_ENCRYPTION_KEY: Buffer.alloc(16).toString('base64') })).toThrow(/APP_ENCRYPTION_KEY/)
  })

  it('rejects wrong URL protocols', () => {
    expect(() => loadEnv({ ...valid, DATABASE_URL: 'mysql://x' })).toThrow(/DATABASE_URL/)
    expect(() => loadEnv({ ...valid, REDIS_URL: 'http://x' })).toThrow(/REDIS_URL/)
  })

  it('reports every missing variable', () => {
    expect(() => loadEnv({})).toThrow(/DATABASE_URL[\s\S]*REDIS_URL|REDIS_URL[\s\S]*DATABASE_URL/)
  })
})
