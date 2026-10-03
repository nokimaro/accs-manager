import { argon2, randomBytes, timingSafeEqual } from 'node:crypto'

// OWASP minimum for argon2id: m=19 MiB, t=2, p=1
const PARAMS = { memory: 19_456, passes: 2, parallelism: 1, tagLength: 32 }

function derive(password: string, nonce: Buffer, p: typeof PARAMS): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    argon2('argon2id', { message: password, nonce, ...p }, (err, key) => (err ? reject(err) : resolve(key)))
  })
}

/** Returns a PHC-style string: $argon2id$v=19$m=19456,t=2,p=1$<salt>$<hash> (base64, no padding). */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16)
  const hash = await derive(password, salt, PARAMS)
  const b64 = (b: Buffer) => b.toString('base64').replace(/=+$/, '')
  return `$argon2id$v=19$m=${PARAMS.memory},t=${PARAMS.passes},p=${PARAMS.parallelism}$${b64(salt)}$${b64(hash)}`
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const match = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$([^$]+)\$([^$]+)$/.exec(stored)
  if (!match) return false
  const [, m, t, p, salt, hash] = match as unknown as [string, string, string, string, string, string]
  const expected = Buffer.from(hash, 'base64')
  const actual = await derive(password, Buffer.from(salt, 'base64'), {
    memory: Number(m),
    passes: Number(t),
    parallelism: Number(p),
    tagLength: expected.length,
  })
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}
