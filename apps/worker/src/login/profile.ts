import type { User } from '@mtcute/core'
import type { SessionProfile } from '../telegram/session.ts'

/** The profile fields the panel keeps, from the user a login returned. */
export function profileOf(user: User): SessionProfile {
  return {
    tgUserId: user.id,
    phone: user.phoneNumber ?? null,
    username: user.username ?? null,
    firstName: user.firstName || null,
    lastName: user.lastName ?? null,
    isPremium: user.isPremium,
    dcId: user.dcId ?? null,
  }
}
