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
import type { PasswordState, TelegramSession } from '../telegram/session.ts'

export interface SetCloudPassword {
  /** ciphertext; null — use the password the panel knows */
  currentPasswordEnc: string | null
  newPasswordEnc: string
  hint: string | null
  email: string | null
}

const WRONG = 'PASSWORD_HASH_INVALID'

/** What the panel knows about the password after asking Telegram which one it accepts now. */
interface Known {
  state: PasswordState
  stored: string | null
  recoveryEmail: string | null
  /** a stored password Telegram no longer accepts was just forgotten */
  forgotten: boolean
}

/**
 * The cloud (2FA) password of connected accounts: what Telegram says about it, checking and remembering the
 * current one, setting or changing it (with an optional recovery email and its code). Secrets arrive encrypted
 * and are stored encrypted — written only after Telegram accepted them.
 *
 * A password set together with a new recovery email may apply only once the email is confirmed (TDLib documents
 * this) or at once: it is kept as pending, and whenever the panel looks (state, confirm, skip) it asks Telegram
 * which password works and keeps that one.
 */
export function createCloudPassword(deps: WorkerDeps, runningSession: (accountId: string) => TelegramSession | undefined) {
  const { db, cipher, logger } = deps

  async function load(accountId: string): Promise<{ stored: string | null; pending: string | null }> {
    const [row] = await db
      .select({ stored: accounts.cloudPasswordEnc, pending: accounts.cloudPasswordPendingEnc })
      .from(accounts)
      .where(eq(accounts.id, accountId))
    return { stored: row?.stored ? cipher.decrypt(row.stored) : null, pending: row?.pending ? cipher.decrypt(row.pending) : null }
  }
  const save = (accountId: string, values: { stored?: string | null; pending?: string | null }) =>
    db
      .update(accounts)
      .set({
        ...(values.stored !== undefined ? { cloudPasswordEnc: values.stored === null ? null : cipher.encrypt(values.stored) } : {}),
        ...(values.pending !== undefined ? { cloudPasswordPendingEnc: values.pending === null ? null : cipher.encrypt(values.pending) } : {}),
      })
      .where(eq(accounts.id, accountId))

  /** The recovery email when Telegram accepts `password`, false when it does not. */
  async function accepts(session: TelegramSession, state: PasswordState, password: string): Promise<{ email: string | null } | false> {
    if (!state.hasPassword) return false
    try {
      return { email: await session.recoveryEmail(password) }
    } catch (err) {
      if (tl.RpcError.is(err, WRONG)) return false
      throw err
    }
  }

  /**
   * Brings the stored and pending passwords in line with Telegram: a pending one Telegram accepts becomes the
   * stored one; a pending one is dropped once no email waits for its code; a stored one Telegram no longer accepts
   * (changed or removed outside the panel) is forgotten.
   */
  async function reconcile(accountId: string, session: TelegramSession): Promise<Known> {
    const state = await session.passwordState()
    const loaded = await load(accountId)
    const pending = loaded.pending
    let stored = loaded.stored
    let recoveryEmail: string | null = null
    if (pending !== null) {
      const applied = await accepts(session, state, pending)
      if (applied) {
        await save(accountId, { stored: pending, pending: null })
        return { state, stored: pending, recoveryEmail: applied.email, forgotten: false }
      }
      // no email waits any more (confirmed with another password, or skipped): Telegram will never apply it
      if (!state.unconfirmedEmailPattern) await save(accountId, { pending: null })
    }
    let forgotten = false
    if (stored !== null) {
      const ok = await accepts(session, state, stored)
      if (ok) recoveryEmail = ok.email
      else {
        await save(accountId, { stored: null })
        stored = null
        forgotten = true
      }
    }
    return { state, stored, recoveryEmail, forgotten }
  }

  /** Telegram's refusals in the shape the api expects; anything unforeseen is logged and passed on as text. */
  function failure(err: unknown, accountId: string): CloudPasswordError {
    if (tl.RpcError.is(err)) {
      const seconds = (err as tl.RpcError & { seconds?: number }).seconds
      switch (err.text) {
        case 'SESSION_TOO_FRESH_%d':
        case 'PASSWORD_TOO_FRESH_%d':
          return { error: 'too_fresh', retryAfterSec: seconds ?? 0 }
        case 'FLOOD_WAIT_%d':
          return { error: 'flood', retryAfterSec: seconds ?? 0 }
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
        const { state, stored, recoveryEmail } = await reconcile(accountId, session)
        return {
          info: {
            hasPassword: state.hasPassword,
            hint: state.hint,
            known: stored !== null,
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
      await save(accountId, { stored: password })
      return { ok: true }
    },

    async set(accountId: string, input: SetCloudPassword): Promise<CloudPasswordSetResult> {
      const session = runningSession(accountId)
      if (!session) return { error: 'not_running' }
      const next = cipher.decrypt(input.newPasswordEnc)
      const given = input.currentPasswordEnc === null ? null : cipher.decrypt(input.currentPasswordEnc)
      try {
        // first learn which password is in force (a pending one may have been applied meanwhile)
        const { state, stored, forgotten } = await reconcile(accountId, session)
        const current = state.hasPassword ? (given ?? stored) : null
        if (state.hasPassword && current === null) return { error: forgotten ? 'stale_password' : 'password_unknown' }
        let emailCode
        try {
          emailCode = await session.setPassword({ current, next, hint: input.hint, email: input.email })
        } catch (err) {
          if (!tl.RpcError.is(err, WRONG)) throw err
          if (given !== null) return { error: 'wrong_password' }
          await save(accountId, { stored: null })
          return { error: 'stale_password' }
        }
        if (emailCode) {
          // in force now or only after the email code: the next look at Telegram decides
          await save(accountId, { pending: next, ...(given !== null && state.hasPassword ? { stored: given } : {}) })
          return { emailCodeNeeded: { pattern: emailCode.emailPattern, length: emailCode.emailCodeLength } }
        }
        await save(accountId, { stored: next, pending: null })
        return { ok: true }
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
        // after a confirm or a skip, keep whichever password Telegram accepts now
        if (action !== 'resend') await reconcile(accountId, session)
        return { ok: true }
      } catch (err) {
        return failure(err, accountId)
      }
    },
  }
}

export type CloudPassword = ReturnType<typeof createCloudPassword>
