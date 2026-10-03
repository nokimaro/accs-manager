import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@workspace/ui/components/dropdown-menu'
import { afterEach, describe, expect, it } from 'vitest'
import { ThemeProvider } from './theme-provider'
import { ThemeMenuGroup } from './theme-menu-group'

// opened via defaultOpen: in jsdom Base UI ignores a trigger click right after a previous test's menu
async function openMenu() {
  const user = userEvent.setup()
  render(
    <ThemeProvider>
      <DropdownMenu defaultOpen>
        <DropdownMenuTrigger>Меню</DropdownMenuTrigger>
        <DropdownMenuContent>
          <ThemeMenuGroup />
        </DropdownMenuContent>
      </DropdownMenu>
    </ThemeProvider>,
  )
  await screen.findByRole('menu')
  return user
}

afterEach(() => {
  localStorage.clear()
  document.documentElement.className = ''
})

// matchMedia is stubbed in test/setup.ts (never dark), so "system" resolves to light
describe('ThemeMenuGroup', () => {
  it('follows the system theme by default', async () => {
    await openMenu()
    expect(screen.getByRole('menuitemradio', { name: 'Как в системе' })).toHaveAttribute('aria-checked', 'true')
    expect(document.documentElement).toHaveClass('light')
  })

  it('switches to dark and remembers the choice', async () => {
    const user = await openMenu()
    await user.click(screen.getByRole('menuitemradio', { name: 'Тёмная' }))
    expect(document.documentElement).toHaveClass('dark')
    expect(document.documentElement).not.toHaveClass('light')
    expect(localStorage.getItem('theme')).toBe('dark')
  })

  it('marks the saved theme as selected', async () => {
    localStorage.setItem('theme', 'dark')
    await openMenu()
    expect(screen.getByRole('menuitemradio', { name: 'Тёмная' })).toHaveAttribute('aria-checked', 'true')
    expect(document.documentElement).toHaveClass('dark')
  })
})
