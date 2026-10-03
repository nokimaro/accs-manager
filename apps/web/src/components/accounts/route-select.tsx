import type { ProxyDto } from '@workspace/shared/proxies'
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectSeparator, SelectTrigger, SelectValue } from '@workspace/ui/components/select'
import { proxyLabel } from '@/lib/accounts'

/** How an account reaches Telegram: a proxy id, or one of the special choices. */
export type RouteChoice = string

export function RouteSelect(props: {
  id?: string
  value: RouteChoice | null
  onChange: (value: RouteChoice) => void
  proxies: ProxyDto[]
  /** extra choices before the proxy list, e.g. auto / direct / skip */
  special: { value: string; label: string }[]
  disabled?: boolean
  placeholder?: string
  'aria-label'?: string
}) {
  const items = [...props.special, ...props.proxies.map((p) => ({ value: p.id, label: proxyLabel(p) }))]
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
        {props.proxies.length > 0 && (
          <>
            <SelectSeparator />
            <SelectGroup>
              <SelectLabel>Свободные прокси</SelectLabel>
              {props.proxies.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {proxyLabel(p)}
                </SelectItem>
              ))}
            </SelectGroup>
          </>
        )}
      </SelectContent>
    </Select>
  )
}
