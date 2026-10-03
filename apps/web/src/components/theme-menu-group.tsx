import { DropdownMenuGroup, DropdownMenuLabel } from '@workspace/ui/components/dropdown-menu'
import { ToggleGroup, ToggleGroupItem } from '@workspace/ui/components/toggle-group'
import { type LucideIcon, MonitorIcon, MoonIcon, SunIcon } from 'lucide-react'
import { type Theme, useTheme } from '@/components/theme-provider'

const themes: { value: Theme; label: string; icon: LucideIcon }[] = [
  { value: 'light', label: 'Светлая', icon: SunIcon },
  { value: 'dark', label: 'Тёмная', icon: MoonIcon },
  { value: 'system', label: 'Как в системе', icon: MonitorIcon },
]

/** One row in the user menu: «Тема» and an icon-only segmented switch. */
export function ThemeMenuGroup() {
  const { theme, setTheme } = useTheme()
  return (
    <DropdownMenuGroup className="flex items-center justify-between gap-2 pr-1">
      <DropdownMenuLabel>Тема</DropdownMenuLabel>
      <ToggleGroup
        aria-label="Тема"
        variant="outline"
        size="sm"
        spacing={0}
        value={[theme]}
        // pressing the active item would empty the group; keep the current theme instead
        onValueChange={(value) => value[0] && setTheme(value[0] as Theme)}
      >
        {themes.map(({ value, label, icon: Icon }) => (
          <ToggleGroupItem key={value} value={value} aria-label={label} title={label}>
            <Icon />
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
    </DropdownMenuGroup>
  )
}
