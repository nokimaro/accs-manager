import { afterEach, expect, it, vi } from 'vitest'
import { reloadOnceOnStaleChunks } from './stale-chunks'

afterEach(() => sessionStorage.clear())

it('reloads once when a lazy chunk of an old build fails to load, never in a loop', () => {
  const reload = vi.fn()
  reloadOnceOnStaleChunks(reload)
  const first = new Event('vite:preloadError', { cancelable: true })
  window.dispatchEvent(first)
  expect(reload).toHaveBeenCalledOnce()
  expect(first.defaultPrevented).toBe(true)

  // the reloaded page fails again: let the error surface instead of reloading forever
  const second = new Event('vite:preloadError', { cancelable: true })
  window.dispatchEvent(second)
  expect(reload).toHaveBeenCalledOnce()
  expect(second.defaultPrevented).toBe(false)
})
