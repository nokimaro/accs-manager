import { tl } from '@mtcute/core'
import { accounts, eq } from '@workspace/db'
import type {
  CloudPasswordEmailResult,
  CloudPasswordError,
  CloudPasswordInfoResult,
  CloudPasswordSetResult,
  CloudPasswordVerifyResult,
} from '@workspace/shared/commands'
import type { WorkerDeps } from '../deps.ts'
import type { TelegramSession } from '../telegram/session.ts'

export interface SetCloudPassword {
  /** ciphertext; null — use the password the panel knows */
  currentPasswordEnc: string | null
  newPasswordEnc: string
  hint: string | null
  email: string | null
}

const WRONG = 'PASSWORD_HASH_INVALID'

/**
 * The cloud (2FA) password of connected accounts: what Telegram says about it, checking and remembering the
 * current one, setting or changing it (with an optional recovery email and its code). Secrets arrive encrypted
 * and are stored encrypted — written only after Telegram accepted them.
 */
export function createCloudPassword(deps: WorkerDeps, runningSession: (accountId: string) => TelegramSession | undefined) {
  const { db, cipher, logger } = deps

  async function stored(accountId: string): Promise<string | null> {
    const [row] = await db.select({ enc: accounts.cloudPasswordEnc }).from(accounts).where(eq(accounts.id, accountId))
    return row?.enc ? cipher.decrypt(row.enc) : null
  }
  const remember = (accountId: string, password: string | null) =>
    db
      .update(accounts)
      .set({ cloudPasswordEnc: password === null ? null : cipher.encrypt(password) })
      .where(eq(accounts.id, accountId))

  /** Telegram's refusals in the shape the api expects; anything unforeseen is logged and passed on as text. */
  function failure(err: unknown, accountId: string): CloudPasswordError {
    if (tl.RpcError.is(err)) {
      const seconds = (err as tl.RpcError & { seconds?: number }).seconds
      switch (err.text) {
        case 'SESSION_TOO_FRESH_%d':
        case 'PASSWORD_TOO_FRESH_%d':
          return { error: 'too_fresh', retryAfterSec: seconds ?? 0 }
        case 'EMAIL_INVALID':
          return { error: 'email_invalid' }
        case 'CODE_INVALID':
          return { error: 'code_invalid' }
        case 'EMAIL_HASH_EXPIRED':
          return { error: 'code_expired' }
      }
    }
    logger.warn({ err, accountId }, 'cloud password: operation failed')
    return { error: 'other', message: tl.RpcError.is(err) ? `${err.code} ${err.text}` : err instanceof Error ? err.message.slice(0, 300) : String(err) }
  }

  return {
    async info(accountId: string): Promise<CloudPasswordInfoResult> {
      const session = runningSession(accountId)
      if (!session) return { error: 'not_running' }
      try {
        const state = await session.passwordState()
        let password = await stored(accountId)
        let recoveryEmail: string | null = null
        if (password !== null && !state.hasPassword) {
          // removed outside the panel
          await remember(accountId, null)
          password = null
        }
        if (password !== null) {
          try {
            recoveryEmail = await session.recoveryEmail(password)
          } catch (err) {
            if (!tl.RpcError.is(err, WRONG)) throw err
            // changed outside the panel: the stored one is useless now
            await remember(accountId, null)
            password = null
          }
        }
        return {
          info: {
            hasPassword: state.hasPassword,
            hint: state.hint,
            known: password !== null,
            hasRecovery: state.hasRecovery,
            recoveryEmail,
            unconfirmedEmailPattern: state.unconfirmedEmailPattern,
            pendingResetAt: state.pendingResetAt?.toISOString() ?? null,
          },
        }
      } catch (err) {
        return failure(err, accountId)
      }
    },

    async verify(accountId: string, passwordEnc: string): Promise<CloudPasswordVerifyResult> {
      const session = runningSession(accountId)
      if (!session) return { error: 'not_running' }
      const password = cipher.decrypt(passwordEnc)
      try {
        // getPasswordSettings needs the right password: a cheap check with no side effect
        await session.recoveryEmail(password)
      } catch (err) {
        if (tl.RpcError.is(err, WRONG)) return { error: 'wrong_password' }
        return failure(err, accountId)
      }
      await remember(accountId, password)
      return { ok: true }
    },

    async set(accountId: string, input: SetCloudPassword): Promise<CloudPasswordSetResult> {
      const session = runningSession(accountId)
      if (!session) return { error: 'not_running' }
      const next = cipher.decrypt(input.newPasswordEnc)
      const given = input.currentPasswordEnc === null ? null : cipher.decrypt(input.currentPasswordEnc)
      try {
        const state = await session.passwordState()
        const current = state.hasPassword ? (given ?? (await stored(accountId))) : null
        if (state.hasPassword && current === null) return { error: 'password_unknown' }
        let emailCode
        try {
          emailCode = await session.setPassword({ current, next, hint: input.hint, email: input.email })
        } catch (err) {
          if (!tl.RpcError.is(err, WRONG)) throw err
          if (given !== null) return { error: 'wrong_password' }
          await remember(accountId, null)
          return { error: 'stale_password' }
        }
        // in force now, even while a recovery email waits for its code
        await remember(accountId, next)
        return emailCode ? { emailCodeNeeded: { pattern: emailCode.emailPattern, length: emailCode.emailCodeLength } } : { ok: true }
      } catch (err) {
        return failure(err, accountId)
      }
    },

    async email(accountId: string, action: 'confirm' | 'resend' | 'cancel', codeEnc: string | null): Promise<CloudPasswordEmailResult> {
      const session = runningSession(accountId)
      if (!session) return { error: 'not_running' }
      try {
        if (action === 'confirm') await session.confirmPasswordEmail(codeEnc === null ? '' : cipher.decrypt(codeEnc))
        else if (action === 'resend') await session.resendPasswordEmail()
        else await session.cancelPasswordEmail()
        return { ok: true }
      } catch (err) {
        return failure(err, accountId)
      }
    },
  }
}

export type CloudPassword = ReturnType<typeof createCloudPassword>
