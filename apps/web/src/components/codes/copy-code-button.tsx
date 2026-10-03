import { Button } from '@workspace/ui/components/button'
import { toast } from '@workspace/ui/components/toast'
import { CopyIcon } from 'lucide-react'

export function CopyCodeButton({ code }: { code: string }) {
  return (
    <Button
      variant="outline"
      size="sm"
      className="font-mono"
      aria-label={`Скопировать код ${code}`}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(code)
          toast.add({ title: 'Код скопирован', description: code })
        } catch {
          toast.add({ title: 'Не удалось скопировать', description: 'Браузер не дал доступ к буферу обмена' })
        }
      }}
    >
      {code}
      <CopyIcon data-icon="inline-end" />
    </Button>
  )
}
