import * as React from 'react'
import { Button } from '@workspace/ui/components/button'
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from '@workspace/ui/components/sheet'
import { MenuIcon } from 'lucide-react'
import { NavTabs } from './nav-tabs'

export function MobileNav() {
  const [open, setOpen] = React.useState(false)
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger render={<Button variant="ghost" size="icon" aria-label="Открыть меню" />}>
        <MenuIcon />
      </SheetTrigger>
      <SheetContent side="left">
        <SheetHeader>
          <SheetTitle>accs-manager</SheetTitle>
        </SheetHeader>
        <div className="px-4">
          <NavTabs orientation="vertical" onNavigate={() => setOpen(false)} />
        </div>
      </SheetContent>
    </Sheet>
  )
}
