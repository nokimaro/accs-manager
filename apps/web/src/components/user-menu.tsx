import { useQueryClient } from '@tanstack/react-query'
import { useRouter } from '@tanstack/react-router'
import { Avatar, AvatarFallback } from '@workspace/ui/components/avatar'
import { Button } from '@workspace/ui/components/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@workspace/ui/components/dropdown-menu'
import { KeyIcon, LogOutIcon } from 'lucide-react'
import { ThemeMenuGroup } from '@/components/theme-menu-group'
import { api } from '@/lib/api'
import { authKeys } from '@/lib/auth'

export function UserMenu({ login, onChangePassword }: { login: string; onChangePassword: () => void }) {
  const queryClient = useQueryClient()
  const router = useRouter()
  const logout = async () => {
    await api('/auth/logout', { method: 'POST' })
    queryClient.clear()
    queryClient.setQueryData(authKeys.me, null)
    await router.invalidate()
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant="ghost" aria-label="Меню пользователя" />}>
        <Avatar className="size-6">
          <AvatarFallback>{login.slice(0, 2).toUpperCase()}</AvatarFallback>
        </Avatar>
        <span className="hidden sm:inline">{login}</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuGroup>
          <DropdownMenuLabel>{login}</DropdownMenuLabel>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <ThemeMenuGroup />
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuItem onClick={onChangePassword}>
            <KeyIcon />
            Сменить пароль
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => void logout()}>
            <LogOutIcon />
            Выйти
          </DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
