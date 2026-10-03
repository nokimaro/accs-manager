import { Link, useRouterState } from '@tanstack/react-router'
import { Tabs, TabsList, TabsTrigger } from '@workspace/ui/components/tabs'
import { KeyRoundIcon, NetworkIcon, ScrollTextIcon, SettingsIcon, ShieldIcon, UsersIcon } from 'lucide-react'

export const NAV_ITEMS = [
  { to: '/', label: 'Коды', icon: KeyRoundIcon },
  { to: '/accounts', label: 'Аккаунты', icon: UsersIcon },
  { to: '/proxies', label: 'Прокси', icon: NetworkIcon },
  { to: '/audit', label: 'Аудит', icon: ScrollTextIcon },
  { to: '/admins', label: 'Админы', icon: ShieldIcon },
  { to: '/settings', label: 'Настройки', icon: SettingsIcon },
] as const

export function activeNavItem(pathname: string): string | null {
  const match = NAV_ITEMS.find((item) => (item.to === '/' ? pathname === '/' : pathname === item.to || pathname.startsWith(`${item.to}/`)))
  return match?.to ?? null
}

/** Route links rendered as line tabs: built-in Tabs styling, real <a> navigation. */
export function NavTabs({ orientation = 'horizontal', onNavigate }: { orientation?: 'horizontal' | 'vertical'; onNavigate?: () => void }) {
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  return (
    <Tabs value={activeNavItem(pathname)} orientation={orientation}>
      <TabsList variant="line" aria-label="Разделы">
        {NAV_ITEMS.map((item) => (
          <TabsTrigger key={item.to} value={item.to} nativeButton={false} render={<Link to={item.to} onClick={onNavigate} />}>
            <item.icon data-icon="inline-start" />
            {item.label}
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  )
}
