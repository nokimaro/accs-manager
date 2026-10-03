import { describe, expect, it } from 'vitest'
import { activeNavItem } from './nav-tabs'

describe('activeNavItem', () => {
  it('matches the root only exactly', () => {
    expect(activeNavItem('/')).toBe('/')
    expect(activeNavItem('/settings')).toBe('/settings')
  })
  it('matches nested routes and ignores lookalikes', () => {
    expect(activeNavItem('/accounts/42')).toBe('/accounts')
    expect(activeNavItem('/accountsx')).toBeNull()
    expect(activeNavItem('/login')).toBeNull()
  })
})
