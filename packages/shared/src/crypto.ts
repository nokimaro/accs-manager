import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

const VERSION = 'v1'
const ALGORITHM = 'aes-256-gcm'

export interface Cipher {
  /** Returns `v1:<iv>:<ciphertext>:<tag>` (base64 parts). */
  encrypt(plaintext: string): string
  /** Throws if the token is malformed, uses an unknown version, or was tampered with. */
  decrypt(token: string): string
}

export function createCipher(keyBase64: string): Cipher {
  const key = Buffer.from(keyBase64, 'base64')
  if (key.length !== 32) throw new Error('APP_ENCRYPTION_KEY must be 32 bytes encoded as base64')

  return {
    encrypt(plaintext) {
      const iv = randomBytes(12)
      const cipher = createCipheriv(ALGORITHM, key, iv)
      const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
      const tag = cipher.getAuthTag()
      return [VERSION, iv.toString('base64'), ciphertext.toString('base64'), tag.toString('base64')].join(':')
    },
    decrypt(token) {
      const parts = token.split(':')
      if (parts.length !== 4 || parts[0] !== VERSION) throw new Error('Unsupported ciphertext format')
      const [, iv, ciphertext, tag] = parts as [string, string, string, string]
      const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(iv, 'base64'))
      decipher.setAuthTag(Buffer.from(tag, 'base64'))
      return Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64')), decipher.final()]).toString('utf8')
    },
  }
}
