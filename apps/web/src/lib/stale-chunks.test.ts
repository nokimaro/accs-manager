import { afterEach, expect, it, vi } from 'vitest'
import { isChunkLoadError, reloadOnStaleChunks } from './stale-chunks'

afterEach(() => sessionStorage.clear())

it('reloads when a lazy chunk fails, but not in a loop, and again on a later deploy', () => {
  const reload = vi.fn()
  let now = 1_000_000
  reloadOnStaleChunks(reload, () => now)
  const fail = () => {
    const event = new Event('vite:preloadError', { cancelable: true })
    window.dispatchEvent(event)
    return event.defaultPrevented
  }

  expect(fail()).toBe(true)
  expect(reload).toHaveBeenCalledTimes(1)

  // the reloaded page fails again right away: let the error surface instead of reloading forever
  now += 2_000
  expect(fail()).toBe(false)
  expect(reload).toHaveBeenCalledTimes(1)

  // the same tab meets the next deploy much later: reload again
  now += 60_000
  expect(fail()).toBe(true)
  expect(reload).toHaveBeenCalledTimes(2)
})

it('recognises chunk load errors across browsers', () => {
  expect(isChunkLoadError(new TypeError('Failed to fetch dynamically imported module: http://x/a.js'))).toBe(true)
  expect(isChunkLoadError(new TypeError('error loading dynamically imported module'))).toBe(true)
  expect(isChunkLoadError(new TypeError('Importing a module script failed.'))).toBe(true)
  expect(isChunkLoadError(new Error('Request failed with 500'))).toBe(false)
})
