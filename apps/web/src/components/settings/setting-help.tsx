import * as React from 'react'
import { Button } from '@workspace/ui/components/button'
import { Popover, PopoverContent, PopoverDescription, PopoverHeader, PopoverTitle, PopoverTrigger } from '@workspace/ui/components/popover'
import { InfoIcon } from 'lucide-react'

/** ⓘ next to a setting label: opens on hover on desktop and on tap on touch screens. */
export function SettingHelp({ label, help }: { label: string; help: string }) {
  const [open, setOpen] = React.useState(false)
  const openedByHover = React.useRef(false)
  const pinned = React.useRef(false)

  const onOpenChange = (next: boolean, details: { reason: string }) => {
    // a click right after hover-opening pins the popover instead of toggling it shut;
    // a pinned popover ignores the pointer leaving and closes on click, outside press or Esc
    if (!next && details.reason === 'trigger-press' && openedByHover.current) {
      openedByHover.current = false
      pinned.current = true
      return
    }
    if (!next && details.reason === 'trigger-hover' && pinned.current) return
    openedByHover.current = next && details.reason === 'trigger-hover'
    if (!next) pinned.current = false
    setOpen(next)
  }

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger openOnHover delay={200} render={<Button type="button" variant="ghost" size="icon-xs" aria-label={`Подробнее: ${label}`} />}>
        <InfoIcon />
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80">
        <PopoverHeader>
          <PopoverTitle>{label}</PopoverTitle>
          <PopoverDescription render={<div />} className="flex flex-col gap-2">
            {help.split('\n\n').map((paragraph) => (
              <p key={paragraph}>{paragraph}</p>
            ))}
          </PopoverDescription>
        </PopoverHeader>
      </PopoverContent>
    </Popover>
  )
}
