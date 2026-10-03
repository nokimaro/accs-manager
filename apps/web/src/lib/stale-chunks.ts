const RELOADED_KEY = 'accs:stale-chunk-reload'

/**
 * A tab left open across a deploy requests lazy route chunks that no longer exist. Reload once to pick
 * up the new build; the sessionStorage flag stops a reload loop when reloading does not help.
 */
export function reloadOnceOnStaleChunks(reload: () => void = () => window.location.reload()): void {
  window.addEventListener('vite:preloadError', (event) => {
    try {
      if (sessionStorage.getItem(RELOADED_KEY)) return
      sessionStorage.setItem(RELOADED_KEY, '1')
    } catch {
      return // no storage, no loop guard: let the error surface
    }
    event.preventDefault()
    reload()
  })
}
