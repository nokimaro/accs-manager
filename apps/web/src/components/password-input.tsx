import * as React from 'react'
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from '@workspace/ui/components/input-group'
import { EyeIcon, EyeOffIcon } from 'lucide-react'

export function PasswordInput(props: Omit<React.ComponentProps<typeof InputGroupInput>, 'type'>) {
  const [visible, setVisible] = React.useState(false)
  return (
    <InputGroup>
      <InputGroupInput type={visible ? 'text' : 'password'} {...props} />
      <InputGroupAddon align="inline-end">
        <InputGroupButton size="icon-xs" aria-label={visible ? 'Скрыть' : 'Показать'} onClick={() => setVisible((v) => !v)}>
          {visible ? <EyeOffIcon /> : <EyeIcon />}
        </InputGroupButton>
      </InputGroupAddon>
    </InputGroup>
  )
}
