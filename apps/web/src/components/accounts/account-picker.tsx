import * as React from 'react'
import { accountFullTitle, type AccountDto } from '@workspace/shared/accounts'
import { Combobox, ComboboxContent, ComboboxEmpty, ComboboxInput, ComboboxItem, ComboboxList } from '@workspace/ui/components/combobox'

interface AccountOption {
  id: string
  label: string | null
  phone: string | null
  /** what the input shows once chosen: «OLIMP-1 · +77066843426» */
  title: string
  /** label, phone, @username and name, lowercased — what the search matches */
  search: string
}

const toOption = (a: AccountDto): AccountOption => ({
  id: a.id,
  label: a.label,
  phone: a.phone,
  title: accountFullTitle(a),
  search: [a.label, a.phone, a.username && `@${a.username}`, a.firstName, a.lastName, String(a.tgUserId)].filter(Boolean).join(' ').toLowerCase(),
})

/** «+7 706 684» and «7066 84» both find +77066843426: spaces, brackets, dashes and the plus are ignored for digits. */
function matches(option: AccountOption, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  const digits = q.replace(/[\s()+-]/g, '')
  return option.search.includes(q) || (/^\d+$/.test(digits) && !!option.phone?.includes(digits))
}

/** An account picker with quick search; `null` = all accounts (the clear button). */
export function AccountPicker({ id, accounts, value, onChange, placeholder }: { id?: string; accounts: AccountDto[]; value: string | null; onChange: (id: string | null) => void; placeholder: string }) {
  const options = React.useMemo(() => accounts.map(toOption), [accounts])
  const selected = options.find((o) => o.id === value) ?? null
  return (
    <Combobox<AccountOption>
      items={options}
      value={selected}
      onValueChange={(o) => onChange(o?.id ?? null)}
      itemToStringLabel={(o) => o.title}
      isItemEqualToValue={(a, b) => a.id === b.id}
      filter={(o, query) => matches(o, query)}
    >
      <ComboboxInput id={id} placeholder={placeholder} showClear={selected !== null} className="w-full" />
      <ComboboxContent>
        <ComboboxEmpty>Ничего не найдено</ComboboxEmpty>
        <ComboboxList>
          {(o: AccountOption) => (
            <ComboboxItem key={o.id} value={o}>
              <span className="flex flex-col">
                <span>{o.label ?? (o.phone ? `+${o.phone}` : o.title)}</span>
                {o.label && o.phone && <span className="text-muted-foreground text-xs">+{o.phone}</span>}
              </span>
            </ComboboxItem>
          )}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  )
}
