import {
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
} from '@workspace/ui/components/dropdown-menu'
import { type LucideIcon, MonitorIcon, MoonIcon, SunIcon } from 'lucide-react'
import { type Theme, useTheme } from '@/components/theme-provider'

const themes: { value: Theme; label: string; icon: LucideIcon }[] = [
  { value: 'light', label: 'Светлая', icon: SunIcon },
  { value: 'dark', label: 'Тёмная', icon: MoonIcon },
  { value: 'system', label: 'Как в системе', icon: MonitorIcon },
]

export function ThemeMenuGroup() {
  const { theme, setTheme } = useTheme()
  return (
    <DropdownMenuGroup>
      <DropdownMenuLabel>Тема</DropdownMenuLabel>
      <DropdownMenuRadioGroup value={theme} onValueChange={(value: Theme) => setTheme(value)}>
        {themes.map(({ value, label, icon: Icon }) => (
          <DropdownMenuRadioItem key={value} value={value}>
            <Icon />
            {label}
          </DropdownMenuRadioItem>
        ))}
      </DropdownMenuRadioGroup>
    </DropdownMenuGroup>
  )
}
