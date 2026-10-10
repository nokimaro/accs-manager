import { Button } from '@workspace/ui/components/button'
import { CopyIcon } from 'lucide-react'
import { copyToClipboard } from '@/components/copy-button'

/** The code as a small monospace button that copies it — the same size everywhere a code is shown. */
export function CopyCodeButton({ code }: { code: string }) {
  return (
    <Button variant="outline" size="sm" className="font-mono" aria-label={`Скопировать код ${code}`} onClick={() => void copyToClipboard(code, 'Код скопирован')}>
      {code}
      <CopyIcon data-icon="inline-end" />
    </Button>
  )
}
