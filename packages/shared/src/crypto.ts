import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

const VERSION = 'v1'
const ALGORITHM = 'aes-256-gcm'
const IV_BYTES = 12
const TAG_BYTES = 16

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
      const iv = randomBytes(IV_BYTES)
      const cipher = createCipheriv(ALGORITHM, key, iv)
      const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
      const tag = cipher.getAuthTag()
      return [VERSION, iv.toString('base64'), ciphertext.toString('base64'), tag.toString('base64')].join(':')
    },
    decrypt(token) {
      const parts = token.split(':')
      if (parts.length !== 4 || parts[0] !== VERSION) throw new Error('Unsupported ciphertext format')
      const [, ivPart, ciphertext, tagPart] = parts as [string, string, string, string]
      const iv = Buffer.from(ivPart, 'base64')
      const tag = Buffer.from(tagPart, 'base64')
      // GCM accepts shorter tags (a truncated tag still authenticates): only the full 16 bytes we write are valid
      if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) throw new Error('Malformed ciphertext')
      const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES })
      decipher.setAuthTag(tag)
      return Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64')), decipher.final()]).toString('utf8')
    },
  }
}
