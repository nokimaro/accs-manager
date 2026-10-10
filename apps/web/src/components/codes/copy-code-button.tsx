import { Button } from '@workspace/ui/components/button'
import { CopyIcon } from 'lucide-react'
import { copyToClipboard } from '@/components/copy-button'

export function CopyCodeButton({ code, size = 'sm', className = '' }: { code: string; size?: 'sm' | 'default'; className?: string }) {
  return (
    <Button variant="outline" size={size} className={`font-mono ${className}`} aria-label={`Скопировать код ${code}`} onClick={() => void copyToClipboard(code, 'Код скопирован')}>
      {code}
      <CopyIcon data-icon="inline-end" />
    </Button>
  )
}
