import { Button } from '@workspace/ui/components/button'
import { toast } from '@workspace/ui/components/toast'
import { CopyIcon } from 'lucide-react'

export async function copyToClipboard(value: string, title: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(value)
    toast.add({ title, description: value })
  } catch {
    toast.add({ title: 'Не удалось скопировать', description: 'Браузер не дал доступ к буферу обмена' })
  }
}

/** A small icon button next to a value; `copied` is the toast title. */
export function CopyButton({ value, label, copied }: { value: string; label: string; copied: string }) {
  return (
    <Button variant="ghost" size="icon-xs" aria-label={label} title={label} onClick={() => void copyToClipboard(value, copied)}>
      <CopyIcon />
    </Button>
  )
}
