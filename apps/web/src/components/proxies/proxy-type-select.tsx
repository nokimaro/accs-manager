import type { ProxyType } from '@workspace/shared/proxies'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@workspace/ui/components/select'

const items = [
  { value: 'socks5', label: 'SOCKS5' },
  { value: 'http', label: 'HTTP' },
] as const

export function ProxyTypeSelect({ id, value, onChange }: { id: string; value: ProxyType; onChange: (value: ProxyType) => void }) {
  return (
    <Select items={items} value={value} onValueChange={(v) => v && onChange(v as ProxyType)}>
      <SelectTrigger id={id} className="w-full">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          {items.map((item) => (
            <SelectItem key={item.value} value={item.value}>
              {item.label}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  )
}
