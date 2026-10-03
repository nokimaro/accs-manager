import * as React from 'react'
import { Separator } from '@workspace/ui/components/separator'
import type { StreamStatus } from '@/lib/use-event-stream'
import { ChangePasswordDialog } from './change-password-dialog'
import { ConnectionIndicator } from './connection-indicator'
import { MobileNav } from './mobile-nav'
import { NavTabs } from './nav-tabs'
import { UserMenu } from './user-menu'

/** Top navbar with tabs on desktop; collapses into a Sheet on mobile (< md). */
export function AppHeader({ login, streamStatus }: { login: string; streamStatus: StreamStatus }) {
  const [passwordOpen, setPasswordOpen] = React.useState(false)
  return (
    <header className="bg-background sticky top-0 z-10 border-b">
      <div className="mx-auto flex h-14 max-w-7xl items-center gap-3 px-4 md:px-6">
        <div className="md:hidden">
          <MobileNav />
        </div>
        <span className="font-heading font-semibold">accs-manager</span>
        <Separator orientation="vertical" className="hidden h-6 md:block" />
        <nav className="hidden md:flex" aria-label="Основная навигация">
          <NavTabs />
        </nav>
        <div className="ml-auto flex items-center gap-2">
          <ConnectionIndicator status={streamStatus} />
          <UserMenu login={login} onChangePassword={() => setPasswordOpen(true)} />
        </div>
      </div>
      <ChangePasswordDialog open={passwordOpen} onOpenChange={setPasswordOpen} />
    </header>
  )
}
