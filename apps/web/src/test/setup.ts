import '@testing-library/jest-dom/vitest'
import { cleanup, configure } from '@testing-library/react'
import { afterEach, vi } from 'vitest'

afterEach(() => cleanup())

// whole-app tests (createAppRouter) load the route chunks cold: under a full `pnpm test` with the integration
// projects alongside, the first screen can take over the default 1 s of findBy/waitFor
configure({ asyncUtilTimeout: 3000 })

// jsdom has no matchMedia; the scaffold ThemeProvider uses it
if (typeof window.matchMedia !== 'function') {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  })
}

// jsdom has no scrollTo; the router's scroll restoration calls it
window.scrollTo = vi.fn() as unknown as typeof window.scrollTo
