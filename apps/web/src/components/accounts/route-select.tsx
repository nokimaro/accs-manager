import * as React from 'react'
import type { ProxyDto } from '@workspace/shared/proxies'
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectSeparator, SelectTrigger, SelectValue } from '@workspace/ui/components/select'
import { proxyLabel } from '@/lib/accounts'

/** How an account reaches Telegram: a proxy id, or one of the special choices. */
export type RouteChoice = string

/** A proxy in the list: shared ones say how many accounts already use them. */
function optionLabel(p: ProxyDto): string {
  return p.accounts.length > 0 ? `${proxyLabel(p)} · ${p.accounts.length} акк.` : proxyLabel(p)
}

export function RouteSelect(props: {
  id?: string
  value: RouteChoice | null
  onChange: (value: RouteChoice) => void
  /** proxies the account may take: free ones first, then the ones other accounts already use */
  proxies: ProxyDto[]
  /** extra choices before the proxy list, e.g. auto / reuse / direct / skip */
  special: { value: string; label: string }[]
  disabled?: boolean
  placeholder?: string
  'aria-label'?: string
}) {
  const free = props.proxies.filter((p) => p.accounts.length === 0)
  const shared = props.proxies.filter((p) => p.accounts.length > 0).sort((a, b) => a.accounts.length - b.accounts.length)
  const items = [...props.special, ...props.proxies.map((p) => ({ value: p.id, label: optionLabel(p) }))]
  const groups = [
    { label: 'Свободные прокси', proxies: free },
    { label: 'Уже с аккаунтами', proxies: shared },
  ].filter((g) => g.proxies.length > 0)
  return (
    <Select items={items} value={props.value} onValueChange={(v) => v && props.onChange(v)} disabled={props.disabled}>
      <SelectTrigger id={props.id} className="w-full min-w-56" aria-label={props['aria-label']}>
        <SelectValue placeholder={props.placeholder} />
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          {props.special.map((s) => (
            <SelectItem key={s.value} value={s.value}>
              {s.label}
            </SelectItem>
          ))}
        </SelectGroup>
        {groups.map((g) => (
          <React.Fragment key={g.label}>
            <SelectSeparator />
            <SelectGroup>
              <SelectLabel>{g.label}</SelectLabel>
              {g.proxies.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {optionLabel(p)}
                </SelectItem>
              ))}
            </SelectGroup>
          </React.Fragment>
        ))}
      </SelectContent>
    </Select>
  )
}
