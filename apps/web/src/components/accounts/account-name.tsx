import type * as React from 'react'
import { Link } from '@tanstack/react-router'
import { accountTitle } from '@workspace/shared/accounts'
import { CopyButton } from '@/components/copy-button'

const digits = (phone: string) => phone.replace(/^\+/, '')

/** «+77001234567» with a button that copies the number without the plus. */
export function PhoneCopy({ phone, className }: { phone: string; className?: string }) {
  const number = digits(phone)
  return (
    <span className={`inline-flex items-center gap-1 ${className ?? ''}`}>
      <span className="tabular-nums">+{number}</span>
      <CopyButton value={number} label={`Скопировать номер +${number}`} copied="Номер скопирован" />
    </span>
  )
}

type AccountLike = { label: string | null; phone: string | null; username: string | null; tgUserId?: number | null }

/**
 * The account as a link to its card: the label (or the phone) — and the phone with a copy button whenever there
 * is one, so a label never hides the number. `extra` — a muted line below (name, username).
 */
export function AccountName({ id, account, extra }: { id: string; account: AccountLike; extra?: React.ReactNode }) {
  const phoneIsTitle = !account.label && account.phone
  return (
    <span className="flex flex-col">
      <span className="inline-flex items-center gap-1">
        <Link to="/accounts/$id" params={{ id }} className="font-medium hover:underline">
          {accountTitle(account)}
        </Link>
        {phoneIsTitle && <CopyButton value={digits(account.phone!)} label={`Скопировать номер +${digits(account.phone!)}`} copied="Номер скопирован" />}
      </span>
      {account.label && account.phone && <PhoneCopy phone={account.phone} className="text-muted-foreground text-xs" />}
      {extra && <span className="text-muted-foreground text-xs">{extra}</span>}
    </span>
  )
}
